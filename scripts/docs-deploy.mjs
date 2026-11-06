#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HOST = process.env.ZPI_DEPLOY_HOST ?? "root@101.200.240.206";
const SITE_DIR = process.env.ZPI_DEPLOY_SITE_DIR ?? "/var/www/zpi/html/zpi";
const DOCS_DIR = process.env.ZPI_DEPLOY_DOCS_DIR ?? "/opt/zpi-docs";
const BACKUP_ROOT = process.env.ZPI_DEPLOY_BACKUP_ROOT ?? "/opt/zpi-docs-backups";
const SITE_BACKUP_ROOT = process.env.ZPI_DEPLOY_SITE_BACKUP_ROOT ?? "/var/www/zpi/backups";
const SERVICE = process.env.ZPI_DEPLOY_SERVICE ?? "zpi-docs";
const PORT = process.env.ZPI_DEPLOY_PORT ?? "4401";
const BASE = process.env.ZPI_DEPLOY_BASE ?? "/zpi/docs";
const INTRO = process.env.ZPI_DEPLOY_INTRO ?? "/zpi/";

const PAYLOAD = [
  "scripts",
  "docs",
  "packages",
  "examples",
  "tests",
  "licenses",
  "README.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vitest.config.ts",
  "playwright.config.ts",
  "playwright.interactive.config.ts",
  "biome.json",
  "icon.png",
];

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const remoteScript = [
  "set -e",
  `site_dir=${quote(SITE_DIR)}`,
  `docs_dir=${quote(DOCS_DIR)}`,
  `backup_root=${quote(BACKUP_ROOT)}`,
  `site_backup_root=${quote(SITE_BACKUP_ROOT)}`,
  `service=${quote(SERVICE)}`,
  `port=${quote(PORT)}`,
  `base=${quote(BASE)}`,
  'test -d "$docs_dir/node_modules" || { echo "缺少 $docs_dir/node_modules，请先完成服务器初始化。" >&2; exit 1; }',
  'systemctl cat "$service" >/dev/null || { echo "缺少 systemd 服务 $service，请先完成服务器初始化。" >&2; exit 1; }',
  "ts=$(date +%Y%m%d-%H%M%S)",
  'stage="/tmp/zpi-docs-payload-$ts"',
  'site_backup="$site_backup_root/site-$ts"',
  'source_backup="$backup_root/$ts"',
  'cleanup() { rm -rf "$stage"; }',
  "rollback() {",
  "  code=$?",
  '  echo "部署失败，回滚到部署前版本..." >&2',
  '  if [ -d "$source_backup/scripts" ] && [ -d "$source_backup/docs" ]; then',
  '    rm -rf "$docs_dir/scripts" "$docs_dir/docs" "$docs_dir/packages" "$docs_dir/examples" "$docs_dir/tests" "$docs_dir/licenses"',
  '    cp -a "$source_backup/." "$docs_dir/" || true',
  "  fi",
  '  if [ -f "$site_backup/index.html" ]; then',
  '    rm -rf "$site_dir"',
  '    cp -a "$site_backup" "$site_dir" || true',
  "  fi",
  '  systemctl restart "$service" >/dev/null 2>&1 || true',
  "  cleanup",
  "  exit $code",
  "}",
  'mkdir -p "$site_dir" "$backup_root" "$site_backup_root" "$source_backup" "$stage"',
  'cp -a "$site_dir" "$site_backup"',
  'for dir in scripts docs packages examples tests licenses; do if [ -d "$docs_dir/$dir" ]; then cp -a "$docs_dir/$dir" "$source_backup/"; fi; done',
  'for file in package.json package-lock.json README.md tsconfig.json vitest.config.ts playwright.config.ts playwright.interactive.config.ts biome.json icon.png; do if [ -e "$docs_dir/$file" ]; then cp -a "$docs_dir/$file" "$source_backup/"; fi; done',
  "trap rollback ERR",
  'tar --warning=no-unknown-keyword -xzf - -C "$stage"',
  'cp "$stage/docs/site/index.html" "$stage/docs/site/styles.css" "$stage/docs/site/favicon.svg" "$site_dir/"',
  'rm -rf "$docs_dir/scripts" "$docs_dir/docs" "$docs_dir/packages" "$docs_dir/examples" "$docs_dir/tests" "$docs_dir/licenses"',
  'cp -a "$stage/." "$docs_dir/"',
  'find "$site_dir" "$docs_dir" -name "._*" -delete',
  'chown root:root "$site_dir"/* 2>/dev/null || true',
  'systemctl restart "$service"',
  "sleep 2",
  'systemctl is-active --quiet "$service"',
  'curl -fsS --max-time 15 "http://127.0.0.1:$port$base/" >/dev/null',
  'curl -fsS --max-time 15 "http://127.0.0.1:$port$base/intro/" >/dev/null',
  'curl -fsS --max-time 15 "http://127.0.0.1:$port$base/__search.json" >/dev/null',
  "cleanup",
  'echo "deployed $ts"',
].join("\n");

function exitOf(child) {
  return new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

const hostAddress = HOST.includes("@") ? HOST.slice(HOST.indexOf("@") + 1) : HOST;
const sshArgs = [
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "NumberOfPasswordPrompts=3",
];
if (process.env.ZPI_DEPLOY_SSH_KEY) sshArgs.push("-i", process.env.ZPI_DEPLOY_SSH_KEY);
sshArgs.push(HOST, remoteScript);

console.log(`部署介绍页与文档站到 ${HOST}`);
console.log(`介绍页：http://${hostAddress}${INTRO}`);
console.log(`文档站：http://${hostAddress}${BASE}/`);
console.log("使用 SSH 密钥，或在提示时输入服务器密码。");

const tar = spawn(
  "tar",
  [
    "-C",
    ROOT,
    "--exclude=node_modules",
    "--exclude=dist",
    "--exclude=release",
    "--exclude=test-results",
    "--exclude=.git",
    "--exclude=.qoder",
    "--exclude=.probe",
    "-czf",
    "-",
    ...PAYLOAD,
  ],
  {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  },
);

const ssh = spawn("ssh", sshArgs, { stdio: ["pipe", "inherit", "inherit"] });
tar.stdout.pipe(ssh.stdin);
tar.stdout.on("error", () => {});

try {
  const [tarResult, sshResult] = await Promise.all([exitOf(tar), exitOf(ssh)]);
  if (tarResult.code !== 0) {
    console.error(`打包失败（tar exit ${tarResult.code ?? tarResult.signal}）`);
    process.exitCode = 1;
  } else if (sshResult.code !== 0) {
    console.error(`部署失败（ssh exit ${sshResult.code ?? sshResult.signal}）`);
    process.exitCode = 1;
  } else {
    console.log("部署完成，介绍页与文档站已同步。");
  }
} catch (error) {
  console.error(`部署失败：${error.message}`);
  process.exitCode = 1;
}
