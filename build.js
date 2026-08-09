import * as esbuild from "esbuild";

// Bundles the qrp + xterm dashboard from src/ into public/dist/.
//   node build.js          one-shot build
//   node build.js --watch  rebuild on change
const options = {
  entryPoints: ["src/app.js"],
  bundle: true,
  format: "esm",
  outdir: "public/dist",
  entryNames: "app",
  sourcemap: true,
  minify: process.env.NODE_ENV === "production",
  loader: {
    ".css": "css",
    ".woff": "file",
    ".woff2": "file",
    ".ttf": "file",
  },
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[build] watching src/ for changes…");
} else {
  await esbuild.build(options);
  console.log("[build] wrote public/dist/app.js + app.css");
}
