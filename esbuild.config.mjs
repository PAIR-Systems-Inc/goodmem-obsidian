import esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");
const isProduction = process.argv.includes("production");

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: ["main.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2018",
  sourcemap: isProduction ? false : "inline",
  minify: isProduction,
  outfile: "main.js",
  logLevel: "info",
  external: [
    "obsidian",
    "electron",
    "@codemirror/state",
    "@codemirror/view",
    "@codemirror/language",
    "@codemirror/autocomplete",
    "@codemirror/commands",
    "@codemirror/search",
    "@codemirror/collab",
    "@codemirror/history",
    "@codemirror/fold",
    "@codemirror/stream-parser",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr"
  ]
};

if (isWatch) {
  const context = await esbuild.context(buildOptions);
  await context.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(buildOptions);
}

