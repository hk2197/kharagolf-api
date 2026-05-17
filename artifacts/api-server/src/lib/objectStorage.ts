import { Storage, File } from "@google-cloud/storage";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  constructor() {}

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(file: File, cacheTtlSec: number = 3600): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";

    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      "Content-Type": (metadata.contentType as string) || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers["Content-Length"] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
    });
  }

  /**
   * Save a raw Buffer to private object storage at `<privateDir>/<relativePath>`
   * and return the normalized object entity path (e.g. "/objects/thumbs/abc.jpg").
   * Used for server-generated artifacts (thumbnails, rendered video reels).
   */
  async saveRawBuffer(relativePath: string, buffer: Buffer, contentType: string): Promise<string> {
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
    const fullPath = `${entityDir}${relativePath}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    await file.save(buffer, { contentType, resumable: false });
    return `/objects/${relativePath}`;
  }

  /**
   * Produce a short-lived signed GCS URL for an object entity path
   * (e.g. "/objects/data-exports/123/45.json"). Used by Task #468 so members
   * can download their data export with a real signed URL rather than
   * proxying every byte through the API server. Throws ObjectNotFoundError
   * if the object doesn't exist.
   */
  async getSignedDownloadUrl(objectPath: string, ttlSec = 900): Promise<string> {
    const file = await this.getObjectEntityFile(objectPath);
    return signObjectURL({
      bucketName: file.bucket.name,
      objectName: file.name,
      method: "GET",
      ttlSec,
    });
  }

  /**
   * Task #1799 — Sum the size (and count) of every object stored under a
   * given relative prefix below `<privateDir>/`. Used by the marketing-site
   * admin endpoint to show admins how much space their cached external
   * logos / favicons are using under `marketing-cache/<orgId>/`.
   *
   * `relativePath` is relative to PRIVATE_OBJECT_DIR (matching `saveRawBuffer`).
   * For example, `getStorageUsageByPrefix("marketing-cache/42/")` will list
   * every object whose key starts with `<privateDir>/marketing-cache/42/`
   * and return the total bytes plus how many objects make up that total.
   * Returns zeros when the prefix has no objects.
   */
  async getStorageUsageByPrefix(
    relativePath: string,
  ): Promise<{ totalBytes: number; objectCount: number }> {
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
    const fullPath = `${entityDir}${relativePath}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const [files] = await bucket.getFiles({ prefix: objectName });
    let totalBytes = 0;
    for (const file of files) {
      const size = file.metadata?.size;
      if (size != null) totalBytes += Number(size);
    }
    return { totalBytes, objectCount: files.length };
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  /**
   * Best-effort deletion of an object by its stored path/URL.
   *
   * Used by the account-erasure cron (Task #616) to purge member-uploaded
   * media from object storage when an account is permanently erased. We
   * accept any of the path shapes the codebase persists today:
   *   - "/objects/<entityId>"                          (normalized form)
   *   - "https://storage.googleapis.com/<bucket>/..."  (raw GCS URL)
   *   - "uploads/<id>"                                 (legacy relative form)
   *
   * Returns:
   *   - "deleted"   — the object existed and was removed
   *   - "missing"   — the object did not exist (already gone)
   *   - "skipped"   — the path was empty/unrecognized
   * Throws on transient backend errors so callers can count failures.
   */
  async deleteObjectByPath(rawPath: string | null | undefined): Promise<"deleted" | "missing" | "skipped"> {
    if (!rawPath || typeof rawPath !== "string") return "skipped";
    const trimmed = rawPath.trim();
    if (!trimmed) return "skipped";

    // Skip data-URLs and any non-storage external URL we can't address.
    if (trimmed.startsWith("data:")) return "skipped";

    // Normalize https://storage.googleapis.com/... → /objects/<entityId>
    // when it lives under our private object dir; otherwise we fall through
    // and address the raw bucket/object pair directly so URLs that point at
    // a different bucket/prefix are still cleaned up.
    let candidate = trimmed;
    if (candidate.startsWith("https://storage.googleapis.com/")) {
      const normalized = this.normalizeObjectEntityPath(candidate);
      if (normalized.startsWith("/objects/")) {
        candidate = normalized;
      } else {
        // Raw GCS URL not under our private dir — parse the bucket/object
        // directly so we don't end up prefixing the configured private dir
        // (which would target a different, non-existent file).
        const url = new URL(trimmed);
        const path = url.pathname; // "/<bucket>/<object...>"
        const { bucketName, objectName } = parseObjectPath(path);
        const file = objectStorageClient.bucket(bucketName).file(objectName);
        const [exists] = await file.exists();
        if (!exists) return "missing";
        await file.delete({ ignoreNotFound: true });
        return "deleted";
      }
    }

    // /objects/<entityId> → resolve via the same logic as reads and delete.
    if (candidate.startsWith("/objects/")) {
      try {
        const file = await this.getObjectEntityFile(candidate);
        await file.delete({ ignoreNotFound: true });
        return "deleted";
      } catch (err) {
        if (err instanceof ObjectNotFoundError) return "missing";
        throw err;
      }
    }

    // Treat anything else as a relative path under the configured private
    // dir (legacy mediaTable.objectPath, swing voiceover URLs, etc.).
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
    const fullPath = `${entityDir}${candidate.replace(/^\//, "")}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    const [exists] = await file.exists();
    if (!exists) return "missing";
    await file.delete({ ignoreNotFound: true });
    return "deleted";
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`
    );
  }

  const { signed_url: signedURL } = await response.json() as { signed_url: string };
  return signedURL;
}
