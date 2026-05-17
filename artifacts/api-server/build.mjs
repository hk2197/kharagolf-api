import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function build() {
    try {
          await esbuild.build({
                  bundle: true,
                  platform: 'node',
                  target: 'node20',
                  format: 'esm',
                  sourcemap: true,
                  outdir: path.join(__dirname, 'dist'),
                  outExtension: { '.js': '.mjs' },
                  banner: {
                            js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
                  },
                  external: [
                            'pg-native',
                            'mock-aws-s3',
                            'aws-sdk',
                            'nock',
                            'bcrypt',
                            'sqlite3',
                            'mysql2',
                            'mssql',
                            'tedious',
                            'oracledb',
                            'better-sqlite3',
                            'drizzle-orm',
                            'pg',
                            'cors',
                            'express',
                            'nodemailer',
                            'ws',
                            '@resvg/resvg-js',
                            'google-auth-library',
                            'stream',
                            'util',
                            'events',
                            'http',
                            'https',
                            'url',
                            'fs',
                            'path',
                            'crypto'
                          ]
          });
          console.log('Build succeeded!');
    } catch (error) {
          console.error('Build failed:', error);
          process.exit(1);
    }
}

build();
