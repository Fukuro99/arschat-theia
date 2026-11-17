---
scope: memo
milestone: ms-6
---
# 調査メモ: 移植元 ArsChat のツール実装 (2026-07-05 Sonnet 調査)

ms-6 (M5 ツール+承認+MCP) の残タスク e-4 (run_command) / e-5 (web検索) / e-6 (MCPインポート) の実装指示に使う調査結果の要約。移植元は `C:\Users\takep\source\ArsChat`。

## e-5 用: web-search.ts (src/main/web-search.ts、全98行)

- ほぼ自己完結。追加依存は `turndown ^7.2.4` (+ @types/turndown) のみ、fetch は Node 18+ ビルトイン
- `webSearch(query, maxResults=10)`: DuckDuckGo の HTML 版 (`https://html.duckduckgo.com/html/?q=`) をスクレイピング、正規表現で結果抽出、`uddg` パラメータから実 URL 復元、UA は Chrome 偽装固定
- `fetchPage(url, maxLength=15000)`: HTML なら Turndown で Markdown 化 (script/style/nav/footer 等を除去)、非 HTML は生テキスト打ち切り
- タイムアウト: AbortSignal.timeout で webSearch 15秒 / fetchPage 20秒。リトライ無し、失敗は throw

## e-4 用: code-editor-manager.ts の runCommand (424–485行)

- 移植する最小セット: `runCommand` 本体 + `detectWindowsShell` + `RunCommandRequest/Result` 型 (src/shared/code-editor-types.ts)
- Windows シェル分岐: pwsh.exe を probe (3秒) → 成功なら pwsh (-NoProfile、UTF-8 プリアンブル注入)、失敗なら cmd (`chcp 65001` 前置)。非 Windows は shell:true
- タイムアウト既定 30秒、`proc.kill()` のみ (**プロセスツリーは殺さない — 移植時の改善候補**)
- **出力のサイズ上限が無い** (Buffer 全量蓄積) — 移植時に打ち切りを入れるべき
- 旧承認フロー (index.ts の onCodeEditorToolUse + waitForApproval、5分で自動拒否) は**移植しない**。Theia の ToolConfirmationManager + e-3 の承認 UI が代替
- 検索/diff 系 (computeDiff/myersDiff/globSearch/grepFiles 等) は移植対象外 (SPEC 設計方針3)

## e-6 用: mcp-config.json

- 実体はランタイム生成ファイル: `C:\Users\takep\AppData\Roaming\ArsChat\arschat-data\mcp-config.json` (リポジトリ内にサンプル無し)
- スキーマ (src/shared/types.ts 342–361): `MCPConfig = { servers: MCPServerConfig[] }`、`MCPServerConfig = { name, description?, type: 'stdio'|'http'|'streamable-http', command?, args?, env?, url?, headers?, enabled }` — stdio 系 (command/args/env) と http 系 (url/headers) のハイブリッド
- 実マシンに 4 サーバー登録済み (filesystem / Atlassian / discord / resonitelink)。API キー直埋めは無し (mcp-remote 経由 OAuth)
- 変換先は Theia の `ai-features.mcp.mcpServers` preference。`enabled:false` と `streamable-http` 型の対応可否は変換実装時に @theia/ai-mcp 側スキーマを確認すること
