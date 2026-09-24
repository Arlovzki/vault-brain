import { build } from "esbuild";

// Bundle the Lambda handler into a single ESM file. The AWS SDK is bundled too, so the
// artifact is self-contained. The banner shims `require` for any bundled CJS deps.
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/index.mjs",
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});

console.log("built dist/index.mjs");
