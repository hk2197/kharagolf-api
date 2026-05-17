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
      packages: 'external',
      outdir: path.join(__dirname, 'dist'),
      outExtension: { '.js': '.mjs' },
      entryPoints: [
        path.join(__dirname, 'src/index.ts'),
        path.join(__dirname, 'src/highlightWorker.ts'),
        path.join(__dirname, 'src/swingFpsProbeWorker.ts')
      ]
    });
    console.log('Build completed successfully.');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
