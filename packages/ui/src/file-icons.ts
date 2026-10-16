// File names and extension aliases from ZCode fileDisplayHelpers.ts.
import names from "./file-icon-names.json";

const icons = new Set(names);
const DEFAULT_FILE_ICON_NAME = "document";
const FILE_NAME_ICON_ALIASES: Record<string, string> = {
  ".editorconfig": "editorconfig",
  ".env": "settings",
  ".gitattributes": "git",
  ".gitignore": "git",
  ".npmrc": "npm",
  ".nvmrc": "nodejs_alt",
  ".prettierrc": "prettier",
  ".yarnrc": "yarn",
  "babel.config": "babel",
  bun: "lock",
  "bun.lock": "lock",
  cargo: "rust",
  "cargo.lock": "lock",
  dockerfile: "docker",
  eslint: "eslint",
  "eslint.config": "eslint",
  gemfile: "gemfile",
  jest: "jest",
  "jest.config": "jest",
  makefile: "makefile",
  "package-lock": "lock",
  "pnpm-lock": "lock",
  readme: "readme",
  tsconfig: "tsconfig",
  vitest: "vitest",
  "vitest.config": "vitest",
  yarn: "yarn",
};

// material-icons 里的图标名和文件扩展名并不总是一一对应，
// 比如 tsx 实际素材叫 react_ts 而不是 react_tsx。这里集中做 alias，避免 mention panel 和输入框 token 出现扩展名对不上图标的问题。
const EXTENSION_ICON_ALIASES: Record<string, string> = {
  backup: "document",
  bash: "console",
  cjs: "javascript",
  cts: "typescript",
  css: "css",
  // Office 扩展名与 Material Icons 素材名不一致，直接用扩展名拼路径会选错图标；
  // 这里显式收敛到同一套产品语义，旧版与新版 Word 文件也共用 word 图标。
  doc: "word",
  docx: "word",
  go: "go",
  html: "html",
  java: "java",
  jpeg: "image",
  jpg: "image",
  js: "javascript",
  jsx: "react",
  json: "json",
  jsonl: "json",
  mjs: "javascript",
  md: "markdown",
  m4a: "audio",
  m4v: "video",
  flac: "audio",
  mov: "video",
  mp3: "audio",
  mp4: "video",
  ogg: "audio",
  opus: "audio",
  mts: "typescript",
  pdf: "pdf",
  php: "php",
  png: "image",
  pptx: "powerpoint",
  py: "python",
  responses: "json",
  rs: "rust",
  sb: "storybook",
  sql: "database",
  sh: "console",
  snap: "snapcraft",
  svg: "svg",
  toml: "toml",
  ts: "typescript",
  tsx: "react_ts",
  txt: "document",
  wav: "audio",
  weba: "audio",
  webm: "video",
  xlsx: "table",
  yaml: "yaml",
  yml: "yaml",
  zsh: "console",
};

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function resolveIconName(filePath: string): string {
  const normalizedPath = normalizePath(filePath);
  if (normalizedPath.endsWith("/")) return "folder";
  const lastSlash = normalizedPath.lastIndexOf("/");
  const leaf = lastSlash === -1 ? normalizedPath : normalizedPath.slice(lastSlash + 1);
  const normalizedLeaf = leaf.toLowerCase();
  const lastDot = leaf.lastIndexOf(".");
  const fileNameWithoutExtension = lastDot === -1 ? normalizedLeaf : normalizedLeaf.slice(0, lastDot);

  const fileNameAliasCandidates = new Set<string>([normalizedLeaf, fileNameWithoutExtension]);

  // 逐段去掉文件名后缀，使 vitest.config.ts、tsconfig.base.json、.env.local
  // 等配置文件优先匹配名称别名，再回退到扩展名图标。
  let stemCandidate = fileNameWithoutExtension;
  while (stemCandidate.includes(".")) {
    stemCandidate = stemCandidate.slice(0, stemCandidate.lastIndexOf("."));
    if (stemCandidate) {
      fileNameAliasCandidates.add(stemCandidate);
    }
  }

  for (const candidate of fileNameAliasCandidates) {
    // 文件名可能恰好是 constructor / __proto__，不能把原型属性当成图标别名。
    const aliasedFileName = Object.hasOwn(FILE_NAME_ICON_ALIASES, candidate)
      ? FILE_NAME_ICON_ALIASES[candidate]
      : undefined;
    if (aliasedFileName) {
      return aliasedFileName;
    }
  }

  if (lastDot === -1) {
    return DEFAULT_FILE_ICON_NAME;
  }

  const extension = leaf.slice(lastDot + 1).toLowerCase();
  return Object.hasOwn(EXTENSION_ICON_ALIASES, extension) ? EXTENSION_ICON_ALIASES[extension] : extension;
}

// 与参考组件相同，素材加载失败后先回退 document，再使用本地图形，避免破图和重试循环。
export const INLINE_FALLBACK_FILE_ICON_SRC = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><path d="M4.5 1.5h4.586L12.5 4.914V13a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 3.5 13V3A1.5 1.5 0 0 1 5 1.5Z" stroke="#94A3B8" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 1.75V5h3.25" stroke="#94A3B8" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
)}`;

export function fallbackFileIconSource(currentSource: string): string | null {
  if (currentSource === INLINE_FALLBACK_FILE_ICON_SRC) return null;
  if (currentSource.endsWith("/document.svg")) return INLINE_FALLBACK_FILE_ICON_SRC;
  return fileIconSource("file.txt");
}

export function fileIconSource(path: string): string {
  const icon = resolveIconName(path);
  return new URL(`./material-icons/${icons.has(icon) ? icon : DEFAULT_FILE_ICON_NAME}.svg`, document.baseURI)
    .href;
}
