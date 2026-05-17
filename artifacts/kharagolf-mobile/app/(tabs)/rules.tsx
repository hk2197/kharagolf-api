import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import Colors from "@/constants/colors";
import { BASE_URL } from "@/utils/api";
import { useAuth } from "@/context/auth";
import { escapeHtml, markdownToHtml, renderMarkdownBlocks } from "@/utils/markdown";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  loading?: boolean;
}

let msgCounter = 0;
function newId() { return `msg-${++msgCounter}`; }

export default function RulesScreen() {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation("common");
  const { token, user } = useAuth();
  const SUGGESTED_QUESTIONS = [
    t("rules.suggestion1"),
    t("rules.suggestion2"),
    t("rules.suggestion3"),
    t("rules.suggestion4"),
    t("rules.suggestion5"),
    t("rules.suggestion6"),
  ];
  // Task #362 — show the club's chosen governing-body wording in the header so
  // players know which Rules variant the assistant is using.
  const orgId = user?.organizationId ?? null;
  const [governingBody, setGoverningBody] = useState<"rna" | "usga">("rna");
  const [localRulesContent, setLocalRulesContent] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [organizationLogoUrl, setOrganizationLogoUrl] = useState<string | null>(null);
  const hasLocalRules = localRulesContent.trim().length > 0;
  const [localRulesOpen, setLocalRulesOpen] = useState(false);
  const [sharingRules, setSharingRules] = useState(false);
  useEffect(() => {
    if (!orgId || !token) return;
    let cancelled = false;
    fetch(`${BASE_URL}/api/organizations/${orgId}/rules-config`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => (r.ok ? r.json() : null))
      .then((data: { rulesGoverningBody?: "rna" | "usga"; localRulesContent?: string; organizationName?: string; logoUrl?: string | null } | null) => {
        if (cancelled || !data) return;
        if (data.rulesGoverningBody) setGoverningBody(data.rulesGoverningBody);
        setLocalRulesContent(data.localRulesContent ?? "");
        setOrganizationName(data.organizationName ?? "");
        setOrganizationLogoUrl(data.logoUrl ?? null);
      })
      .catch(() => { /* fall back to default R&A label */ });
    return () => { cancelled = true; };
  }, [orgId, token]);
  const localRulesBlocks = useMemo(
    () => (localRulesContent ? renderMarkdownBlocks(localRulesContent) : []),
    [localRulesContent],
  );
  // Task #524 — Build a polished, branded PDF (KHARAGOLF wordmark + club name
  // header) using expo-print so players get a printable artefact instead of a
  // raw .md file. Uses the same markdownToHtml helper the web printout relies
  // on so the rendering stays consistent across platforms.
  const handleShareLocalRules = useCallback(async () => {
    if (!localRulesContent.trim() || sharingRules) return;
    setSharingRules(true);
    try {
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert(t("rules.localRules.shareUnavailableTitle"), t("rules.localRules.shareUnavailableBody"));
        return;
      }
      const body = markdownToHtml(localRulesContent);
      const clubLine = organizationName
        ? `<div class="club">${escapeHtml(organizationName)}</div>`
        : "";
      // Task #688 — If the club uploaded a logo, embed it above the club name
      // so the printed PDF matches the club's branding. We try to inline it as
      // a base64 data URL so the PDF renders even when offline; if the fetch
      // fails we fall back to the remote URL (and ultimately to no image).
      let logoDataUrl: string | null = null;
      if (organizationLogoUrl) {
        try {
          const resp = await fetch(organizationLogoUrl);
          if (resp.ok) {
            const contentType = resp.headers.get("content-type") || "image/png";
            const arrayBuf = await resp.arrayBuffer();
            const bytes = new Uint8Array(arrayBuf);
            let binary = "";
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            // eslint-disable-next-line no-undef
            const b64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
            logoDataUrl = `data:${contentType};base64,${b64}`;
          }
        } catch {
          /* fall back to remote URL below */
        }
      }
      const logoSrc = logoDataUrl ?? organizationLogoUrl;
      const logoLine = logoSrc
        ? `<img class="logo" src="${escapeHtml(logoSrc)}" alt="" />`
        : "";
      const generatedLabel = escapeHtml(
        new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
      );
      const pageTitle = escapeHtml(t("rules.localRules.title"));
      const subtitle = escapeHtml(t("rules.localRules.subtitle"));
      const generatedPrefix = escapeHtml(t("rules.localRules.pdfGenerated"));
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${pageTitle}</title>
<style>
  @page { margin: 28mm 18mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #111; line-height: 1.55; font-size: 12pt; margin: 0; }
  header.brand { border-bottom: 3px solid #00ff88; padding-bottom: 14px; margin-bottom: 22px; }
  header.brand .wordmark { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-weight: 800; letter-spacing: 4px; font-size: 11pt; color: #0b3d2a; text-transform: uppercase; }
  header.brand .logo { display: block; max-height: 64px; max-width: 220px; height: auto; width: auto; margin: 8px 0 6px; object-fit: contain; }
  header.brand .club { font-size: 22pt; font-weight: 700; color: #0b3d2a; margin-top: 4px; line-height: 1.2; }
  header.brand .doc-title { font-size: 13pt; font-weight: 600; color: #1a1a1a; margin-top: 10px; }
  header.brand .doc-sub { font-size: 10pt; color: #555; margin-top: 2px; }
  h1 { font-size: 18pt; margin: 18pt 0 8pt; color: #0b3d2a; }
  h2 { font-size: 14pt; margin: 14pt 0 6pt; color: #0b3d2a; }
  h3 { font-size: 12pt; margin: 10pt 0 4pt; color: #0b3d2a; }
  p { margin: 0 0 8pt; }
  ul, ol { padding-left: 20pt; margin: 0 0 8pt; }
  li { margin-bottom: 4pt; }
  strong { color: #0b3d2a; }
  code { background: #f3f3f3; padding: 1px 4px; border-radius: 3px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11pt; }
  footer.gen { margin-top: 26pt; padding-top: 10pt; border-top: 1px solid #ddd; color: #888; font-size: 9pt; }
</style></head><body>
<header class="brand">
  <div class="wordmark">KHARAGOLF</div>
  ${logoLine}
  ${clubLine}
  <div class="doc-title">${pageTitle}</div>
  <div class="doc-sub">${subtitle}</div>
</header>
${body}
<footer class="gen">${generatedPrefix} ${generatedLabel}</footer>
</body></html>`;
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      await Sharing.shareAsync(uri, {
        mimeType: "application/pdf",
        dialogTitle: t("rules.localRules.shareDialogTitle"),
        UTI: "com.adobe.pdf",
      });
    } catch (err) {
      Alert.alert(t("rules.localRules.shareFailedTitle"), err instanceof Error ? err.message : String(err));
    } finally {
      setSharingRules(false);
    }
  }, [localRulesContent, organizationName, organizationLogoUrl, sharingRules, t]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const flatRef = useRef<FlatList<Message>>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 100);
  }, []);

  const sendQuestion = useCallback(async (question: string) => {
    if (!question.trim() || isStreaming) return;
    setInput("");

    const userMsg: Message = { id: newId(), role: "user", content: question.trim() };
    const assistantId = newId();
    const assistantPlaceholder: Message = { id: assistantId, role: "assistant", content: "", loading: true };

    setMessages(prev => [...prev, userMsg, assistantPlaceholder]);
    setIsStreaming(true);
    scrollToBottom();

    const history = messages.slice(-8).map(m => ({ role: m.role, content: m.content }));
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const authHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (token) authHeaders["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`${BASE_URL}/api/public/rules/ask`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ question: question.trim(), history }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string; featureGate?: { message?: string } };
        throw new Error(body.featureGate?.message ?? body.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let accumulated = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let data: { content?: string; done?: boolean; error?: string } | null = null;
          try {
            data = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (!data) continue;
          if (data.error) throw new Error(data.error);
          if (data.content) {
            accumulated += data.content;
            setMessages(prev =>
              prev.map(m => m.id === assistantId ? { ...m, content: accumulated, loading: false } : m)
            );
            scrollToBottom();
          }
          if (data.done) break;
        }
      }
    } catch (err: unknown) {
      if ((err as Error)?.name === "AbortError") return;
      const errMsg = err instanceof Error ? err.message : t("rules.failedResponse");
      setMessages(prev =>
        prev.map(m => m.id === assistantId
          ? { ...m, content: `⚠️ ${errMsg}`, loading: false }
          : m
        )
      );
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [messages, isStreaming, scrollToBottom]);

  const handleSend = useCallback(() => {
    sendQuestion(input);
  }, [input, sendQuestion]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
  }, []);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.headerLeft}>
          <View style={styles.headerIcon}>
            <Text style={{ fontSize: 20 }}>⛳</Text>
          </View>
          <View>
            <Text style={styles.headerTitle}>{t("rules.title")}</Text>
            <Text style={styles.headerSubtitle}>
              {t("rules.headerSubtitle", { body: governingBody === "usga" ? t("rules.bodyUSGA") : t("rules.bodyRnA") })}
              {hasLocalRules ? t("rules.localRulesBadge") : ""}
            </Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          {hasLocalRules && (
            <Pressable
              onPress={() => setLocalRulesOpen(true)}
              style={styles.localRulesBtn}
              accessibilityRole="button"
              accessibilityLabel={t("rules.localRules.viewButton")}
            >
              <Feather name="book-open" size={14} color={Colors.primary} />
              <Text style={styles.localRulesBtnText}>{t("rules.localRules.viewButton")}</Text>
            </Pressable>
          )}
          {messages.length > 0 && (
            <Pressable onPress={() => setMessages([])} style={styles.clearBtn}>
              <Feather name="trash-2" size={16} color={Colors.muted} />
            </Pressable>
          )}
        </View>
      </View>

      {/* Local Rules viewer — Task #406 */}
      <Modal
        visible={localRulesOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setLocalRulesOpen(false)}
      >
        <View style={styles.modalContainer}>
          <View style={[styles.modalHeader, { paddingTop: insets.top + 8 }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.modalTitle}>{t("rules.localRules.title")}</Text>
              <Text style={styles.modalSubtitle}>{t("rules.localRules.subtitle")}</Text>
            </View>
            <Pressable onPress={() => setLocalRulesOpen(false)} style={styles.modalClose} accessibilityLabel={t("rules.localRules.close")}>
              <Feather name="x" size={20} color={Colors.text} />
            </Pressable>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.modalBody}
            showsVerticalScrollIndicator
          >
            {localRulesBlocks.map((block, i) => {
              if (block.kind === "spacer") return <View key={i} style={{ height: 8 }} />;
              if (block.kind === "code-block") {
                return (
                  <Text key={i} style={[styles.mdParagraph, styles.mdCode]}>{block.text}</Text>
                );
              }
              if (block.kind === "table") {
                const renderCell = (cell: typeof block.header[number]) =>
                  cell.map(inl => inl.text).join("");
                const lines: string[] = [];
                lines.push(block.header.map(renderCell).join(" | "));
                for (const row of block.rows) lines.push(row.map(renderCell).join(" | "));
                return (
                  <Text key={i} style={[styles.mdParagraph, styles.mdCode]}>{lines.join("\n")}</Text>
                );
              }
              const renderInlines = () => block.inlines.map((inl, j) => {
                if (inl.type === "bold") return <Text key={j} style={styles.mdBold}>{inl.text}</Text>;
                if (inl.type === "italic") return <Text key={j} style={styles.mdItalic}>{inl.text}</Text>;
                if (inl.type === "code") return <Text key={j} style={styles.mdCode}>{inl.text}</Text>;
                return <Text key={j}>{inl.text}</Text>;
              });
              if (block.kind === "heading") {
                const headingStyle =
                  block.level === 1 ? styles.mdH1 : block.level === 2 ? styles.mdH2 : styles.mdH3;
                return <Text key={i} style={headingStyle}>{renderInlines()}</Text>;
              }
              if (block.kind === "list-item") {
                return (
                  <View key={i} style={styles.mdListItem}>
                    <Text style={styles.mdListMarker}>{block.marker}</Text>
                    <Text style={styles.mdParagraph}>{renderInlines()}</Text>
                  </View>
                );
              }
              return <Text key={i} style={styles.mdParagraph}>{renderInlines()}</Text>;
            })}
          </ScrollView>
          <View style={[styles.modalFooter, { paddingBottom: insets.bottom + 12 }]}>
            <Pressable
              onPress={handleShareLocalRules}
              style={[styles.shareBtn, sharingRules && styles.shareBtnDisabled]}
              disabled={sharingRules}
              accessibilityRole="button"
              accessibilityLabel={t("rules.localRules.shareButton")}
            >
              {sharingRules ? (
                <LoadingSpinner size="small" color="#000" />
              ) : (
                <Feather name="share-2" size={16} color="#000" />
              )}
              <Text style={styles.shareBtnText}>{t("rules.localRules.shareButton")}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Messages or empty state */}
      {messages.length === 0 ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[styles.emptyContainer, { paddingBottom: insets.bottom + 120 }]}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.emptyTitle}>{t("rules.emptyTitle")}</Text>
          <Text style={styles.emptySubtitle}>{t("rules.emptySubtitle")}</Text>
          <View style={styles.suggestionsGrid}>
            {SUGGESTED_QUESTIONS.map(q => (
              <Pressable key={q} style={styles.suggestionChip} onPress={() => sendQuestion(q)}>
                <Text style={styles.suggestionText}>{q}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      ) : (
        <FlatList
          ref={flatRef}
          data={messages}
          keyExtractor={m => m.id}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 120 }}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={scrollToBottom}
          renderItem={({ item }) => (
            <View style={[styles.bubble, item.role === "user" ? styles.userBubble : styles.assistantBubble]}>
              {item.role === "assistant" && (
                <View style={styles.assistantIcon}>
                  <Text style={{ fontSize: 14 }}>⛳</Text>
                </View>
              )}
              <View style={[styles.bubbleContent, item.role === "user" ? styles.userContent : styles.assistantContent]}>
                {item.loading ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <LoadingSpinner size="small" color={Colors.primary} />
                    <Text style={styles.loadingText}>{t("rules.thinking")}</Text>
                  </View>
                ) : (
                  <Text style={item.role === "user" ? styles.userText : styles.assistantText}>
                    {item.content}
                  </Text>
                )}
              </View>
            </View>
          )}
        />
      )}

      {/* Input bar */}
      <View style={[styles.inputBar, { paddingBottom: insets.bottom + 8 }]}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={t("rules.inputPlaceholder")}
          placeholderTextColor={Colors.muted}
          multiline
          maxLength={500}
          onSubmitEditing={handleSend}
          returnKeyType="send"
          editable={!isStreaming}
        />
        {isStreaming ? (
          <Pressable style={styles.stopBtn} onPress={handleStop}>
            <Feather name="square" size={16} color="#fff" />
          </Pressable>
        ) : (
          <Pressable
            style={[styles.sendBtn, !input.trim() && styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!input.trim()}
          >
            <Feather name="send" size={16} color={input.trim() ? "#000" : Colors.muted} />
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  headerIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primary + "20",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
  },
  headerSubtitle: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: Colors.muted,
    marginTop: 1,
  },
  clearBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  localRulesBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 18,
    backgroundColor: Colors.primary + "20",
    borderWidth: 1,
    borderColor: Colors.primary + "40",
  },
  localRulesBtnText: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    color: Colors.primary,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
    gap: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
  },
  modalSubtitle: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.muted,
    marginTop: 2,
  },
  modalClose: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBody: {
    padding: 20,
    paddingBottom: 32,
  },
  modalFooter: {
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.primary,
    paddingVertical: 14,
    borderRadius: 12,
  },
  shareBtnDisabled: {
    opacity: 0.6,
  },
  shareBtnText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#000",
  },
  mdH1: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
    marginTop: 12,
    marginBottom: 8,
  },
  mdH2: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
    marginTop: 10,
    marginBottom: 6,
  },
  mdH3: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
    marginTop: 8,
    marginBottom: 4,
  },
  mdParagraph: {
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
    marginBottom: 6,
  },
  mdBold: {
    fontFamily: "Inter_700Bold",
    color: Colors.text,
  },
  mdItalic: {
    fontStyle: "italic",
    color: Colors.text,
  },
  mdCode: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    backgroundColor: Colors.card,
    paddingHorizontal: 4,
    color: Colors.text,
  },
  mdListItem: {
    flexDirection: "row",
    gap: 8,
    paddingLeft: 4,
    marginBottom: 4,
  },
  mdListMarker: {
    fontSize: 15,
    lineHeight: 22,
    color: Colors.muted,
    minWidth: 20,
  },
  emptyContainer: {
    padding: 24,
    alignItems: "center",
  },
  emptyTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
    textAlign: "center",
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    textAlign: "center",
    marginBottom: 32,
  },
  suggestionsGrid: {
    width: "100%",
    gap: 10,
  },
  suggestionChip: {
    backgroundColor: Colors.card,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  suggestionText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
    lineHeight: 20,
  },
  bubble: {
    flexDirection: "row",
    marginBottom: 16,
    gap: 8,
  },
  userBubble: {
    justifyContent: "flex-end",
  },
  assistantBubble: {
    justifyContent: "flex-start",
    alignItems: "flex-start",
  },
  assistantIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.primary + "20",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginTop: 4,
  },
  bubbleContent: {
    maxWidth: "82%",
    borderRadius: 16,
    padding: 12,
  },
  userContent: {
    backgroundColor: Colors.primary,
    borderBottomRightRadius: 4,
  },
  assistantContent: {
    backgroundColor: Colors.card,
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  userText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#000",
    lineHeight: 22,
  },
  assistantText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
    lineHeight: 22,
  },
  loadingText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.muted,
    fontStyle: "italic",
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    backgroundColor: Colors.card,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  sendBtnDisabled: {
    backgroundColor: Colors.card,
  },
  stopBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.error,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
});
