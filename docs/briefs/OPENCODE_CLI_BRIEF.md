# 実装ブリーフ: OpenCode (CLI) プロバイダの追加

> 指揮 (Opus) 作成。実装・レビューは Codex CLI。作業ブランチ: `feat/opencode-cli` (main = ae7d679 から)。
> 既存の CLI エージェント (Codex / Claude Code) と同じ仕組み (`arschat-providers/src/{common,node,browser}/cli-agent*`) に 3 つ目として足す。
> ユーザーの目的: OpenCode 経由で Edge の Qwen (`edgexpert/qwen3.8-flash-next`、OpenCode 側の設定済みプロバイダ) を ArsChat から動かす。

## 0. 実測した OpenCode 1.18.2 の挙動 (指揮側で確認済み)

- `opencode run --format json [-m provider/model] [--agent plan|build] [--thinking]`。**メッセージは stdin から読める** (positional 不要)。
- 出力は 1 行 1 JSON。各行に `type` と `part`:
  - `{"type":"step_start","part":{"type":"step-start",...}}`
  - `{"type":"text","part":{"id":"prt_…","type":"text","text":"PONG","time":{...}}}` — **差分ではなくパート全体のテキスト** (パート完了時に 1 回)。
  - `{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"status":"completed","title":"ls",...}}}`
  - `{"type":"step_finish","part":{"type":"step-finish","reason":"stop" | "tool-calls",...,"tokens":{...}}}`
  - エラー: `{"type":"error","error":{"name":"UnknownError","data":{"message":"…"}}}` の後に exit code 1。
- **終了判定**: 明示的な完了イベントは無い。ツール使用後に `step_start` → … → `step_finish(stop)` と続くことがあり、
  plan エージェントで書き込みが拒否されると最後が `step_finish(reason:"tool-calls")` のまま exit 0 で終わることもある。
  → 「exit code 0 で close、error イベントなし、step_finish を 1 回以上見た」を成功とする。**途中の step_finish でプロセスを殺さないこと**
  (既存 service は `decoder.done` になった瞬間に killCliTree するので、OpenCode では close 時まで done にしない)。
- `--agent plan`: 書き込みツールは「The user rejected permission…」で拒否され、ハングせず終わる。
  `--agent build` (既定): OpenCode 既定の権限は `"*": allow` で、ファイル編集・コマンド実行を確認なしで行う。
- `opencode models` は 1 行 1 個で `provider/model` を列挙する (例: `edgexpert/qwen3.8-flash-next`, `opencode/big-pickle`)。
- 設定は `~/.config/opencode/opencode.json(c)`、認証は OpenCode のデータディレクトリ。`run` はセッションを OpenCode 側の DB に保存する (ephemeral オプションは無い)。

## 1. 変更点

### 1-1. `common/cli-agents.ts`
- `CliAgentKind` に `'opencode-cli'`、`isCliAgent` も対応。
- `OPENCODE_AGENT_MODES = ['plan', 'build'] as const`。
- `CliAgentSettings` に `opencodeCommand` (既定 `'opencode'`)、`opencodeAgent` (既定 `'plan'`)、`opencodeModel` (既定 `''` = OpenCode 側の既定モデル) を追加。`normalizeCliSettings` も同じ流儀で (不正な agent は `plan`)。
- `CliAgentService` に `listModels(kind: CliAgentKind, settings: CliAgentSettings): Promise<string[]>` を追加 (OpenCode 以外は `[]`)。

### 1-2. `node/cli-agent-service.ts`
- `cliArguments('opencode-cli', s)` = `['run', '--format', 'json', '--thinking', '--agent', s.opencodeAgent, ...(s.opencodeModel ? ['-m', s.opencodeModel] : [])]`。会話は既存どおり stdin (`cliTranscript`)。
- `check`: Codex と同じ `--version` 方式。インストール案内は `npm i -g opencode-ai`。
- `listModels('opencode-cli')`: 作業ディレクトリ解決 (既存の共通メソッド) の cwd で `opencode models` を起動、stdout 最大 1MB・タイムアウト 20 秒、stderr は読み捨て。空行を除き trim した行のうち `^[^\s/]+\/\S.*$` に合う行だけ返す。失敗・タイムアウトは `[]`。後始末は既存の流儀 (killCliTree / destroyCliPipes)。
- request は既存の流れに乗せる。上記「途中で殺さない」終了判定を入れる (decoder にフラグを持たせる等、方法は任せる)。close code 0 なのに step_finish を 1 回も見ていない場合は既存の「CLI が正常な完了通知なしで終了しました。」。

### 1-3. `node/cli-agent-protocol.ts` (CliAgentDecoder)
- `opencode-cli` 用のデコード:
  - `text` → `part.text` を本文に。同じ `part.id` が再度来たら、前回テキストの続き (startsWith) なら差分だけ、それ以外は無視。別パートのテキストを続けて出す時は間に `\n\n` を入れる。
  - `reasoning` (part.type === 'reasoning') → `part.text` を thought に (同じ id の扱いは text と同じ)。
  - `tool_use` / `step_start` / 未知の type → 何も出さない。
  - `step_finish` → 「完了を 1 回見た」を記録するだけ。
  - `error` → `CliAgentOutputError('OpenCode がエラーを返しました。モデル名・接続先・認証を確認してください。')` (error の中身は出さない)。
  - JSON として壊れた行は既存どおりエラー。

### 1-4. `node/cli-agent-env.ts`
- `opencode-cli` の時だけ、許可リストに加えて `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` を通す。それ以外 (各社 API キー等) は渡さない。

### 1-5. `node/arschat-providers-backend-module.ts`
- `new CliAgentLanguageModel('opencode-cli', service)` を追加。名前は `'OpenCode (CLI)'`。

### 1-6. `browser/arschat-provider-preferences.ts`
- `ArschatProviderKind` に `'opencode-cli'`、PROVIDERS の末尾 (claude-code-cli の後) に `{ kind: 'opencode-cli', label: 'OpenCode (CLI)', modelIdFor: () => 'opencode-cli', fixedModelId: 'opencode-cli', group: 'cli' }`。

### 1-7. `browser/cli-agent-preferences.ts`
- キー: `opencode.command` / `opencode.agent` (enum plan, build) / `opencode.model`。
- `opencode.agent` の markdownDescription: 「OpenCode のエージェント。`plan` は読み取り中心で書き込みを拒否します。**警告:** `build` は OpenCode の権限設定に従い、既定ではファイル編集・コマンド実行を確認なしで行います。」
- `opencode.model` の description: 「`provider/model` 形式 (例: `edgexpert/qwen3.8-flash-next`)。空なら OpenCode の既定モデル。チャットヘッダーのモデル欄からも選べます。」

### 1-8. チャットヘッダー (`arschat-chat/src/browser/arschat-chat-widget.tsx`)
- プロバイダ選択の「エージェント (CLI)」グループに OpenCode (CLI) が出る (PROVIDERS から自動のはず)。
- 「権限」select: OpenCode では `opencodeAgent` を plan / build で切り替え。**build は確認ダイアログ + 警告色** (既存の無制限モードと同じ扱い)。
- **モデル select**: OpenCode の時だけ、`cliAgentService.listModels('opencode-cli', settings)` の結果を選択肢にする (取得中は「(取得中...)」、0 件なら「(モデルが見つかりません)」)。先頭に `''` =「(OpenCode の既定)」を置く。選んだ値は `arschat.cliAgents.opencode.model` に **PreferenceScope.User** で保存し、ProviderSwitchService の active model は変えない。現在値は preference から表示。Codex / Claude Code のモデル欄は現状維持。
- プロバイダを OpenCode に切り替えた時と、ヘッダーのモデル欄を開き直した時ではなく「プロバイダ切替時に 1 回」取得すれば十分 (連打で多重起動しないこと、古い応答で上書きしないこと)。

### 1-9. autotest (`browser/cli-agent-autotest-contribution.ts`)
- 既存 3 シナリオの後に、backend env `ARSCHAT_OPENCODE_AUTOTEST_MODEL` が設定されている時だけ OpenCode の 2 シナリオを足す (未設定なら `opencode: SKIP` をログして数えない):
  - `opencode-models`: `listModels` の結果にそのモデルが含まれる。
  - `opencode-pong`: `opencode.model` をそのモデル・`opencode.agent` を plan にして `Reply with exactly: PONG` → `PONG` を含む。
  - `opencode-japanese`: `日本の首都を漢字2文字で` → `東京` を含む。
  - 書き換えた preference は finally で元の値に戻す。
- M2 など他の autotest の CLI 除外に OpenCode も入っていること。

## 2. テスト (jest、`arschat-chat/src/browser/arschat-cli-agents.test.ts` に追加。既存の Codex / Claude の期待値は変えない。PROVIDERS の並びのテストは末尾追加に合わせて更新してよい)

- cliArguments (model 空/指定、agent plan/build)、不正 agent は plan に正規化。
- env: OpenCode では上の 6 変数が通り、`OPENAI_API_KEY` 等は渡らない。Codex / Claude では OpenCode の変数は渡らない。
- decoder: 実測の 3 パターン (PONG / tool 後に text / plan で tool-calls のまま終了) を fixture にして、本文が正しく、**step_finish の時点でプロセスを kill しない**、close 0 で成功。error イベント→固定メッセージ。step_finish なしの close 0 → 失敗。同じ part id の重複・延長。reasoning → thought。
- listModels: 正常・ノイズ行の除外・タイムアウト (fake timers)・spawn error → `[]`。
- widget: OpenCode 選択時に listModels の結果がモデル欄に出る、選択で `arschat.cliAgents.opencode.model` が User スコープで書かれる、build 選択で確認ダイアログ。
- autotest: env 未設定なら OpenCode は SKIP、設定時は 3 シナリオ。

## 3. 完了条件 (実装者が確認)

1. `npm --prefix arschat-providers run build` / `npm --prefix arschat-chat run build` / `npm --prefix arschat-agents run build` が tsc エラー 0。
2. `npm --prefix arschat-chat test` / `npm --prefix arschat-agents test` が全 green。
3. 本物の opencode を起動するテストを書かない (spawn はモック)。node_modules・lib・electron-app は編集しない。コミットしない。

## 4. やらないこと

- OpenCode の設定ファイル・認証ファイルを ArsChat が読む/書くこと。
- `--auto` (確認が必要な権限の自動承認) の対応。
- OpenCode のセッション継続 (`-s` / `-c`)。毎回会話全体を stdin で渡す既存方式のまま。
