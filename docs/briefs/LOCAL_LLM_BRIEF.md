# 実装ブリーフ: ローカル LLM プロバイダの追加 (Ollama / vLLM / llama.cpp / OpenAI 互換)

> 指揮 (Opus) 作成。実装は OpenCode (edgexpert/qwen3.8-flash-next) に委任。作業ブランチ: `feat/local-llm-providers`。
> 実測済み: Edge の vLLM (`http://192.168.1.149:8000/v1`, model `qwen3.8-flash-next`) は tool_calls・streaming とも正常。
> `@theia/ai-openai` の streaming iterator は vLLM の `reasoning` フィールドを思考として扱う (node/openai-streaming-iterator.js:78-84)。

## 0. ゴール

チャットヘッダーのプロバイダ選択に、次の 4 つを追加する。いずれも LM Studio / Unsloth と同じ「OpenAI 互換カスタムエンドポイント」方式で実装する
(= `ai-features.openAiCustom.customOpenAiModels` 配列の固定 id エントリ。登録される LanguageModel id はエントリ id そのもの)。

| kind (= エントリ id) | 表示名 | 既定 URL | 既定 apiKey |
|---|---|---|---|
| `ollama` | `Ollama` | `http://localhost:11434/v1` | なし |
| `vllm` | `vLLM` | `http://localhost:8000/v1` | なし |
| `llamacpp` | `llama.cpp` | `http://localhost:8080/v1` | なし |
| `openai-compatible` | `OpenAI 互換 (その他)` | `http://localhost:8000/v1` | なし |

既存の `lmstudio` / `unsloth` は挙動を一切変えない (既定値・id・表示名とも現状維持)。

## 1. 変更点

### 1-1. `arschat-providers/src/browser/arschat-provider-preferences.ts`
- `ArschatProviderKind` に上の 4 つを追加。
- `ArschatProviderDescriptor` に任意フィールドを追加: `defaultUrl?: string`, `defaultApiKey?: string`, `local?: boolean`。
  - カスタムエンドポイント系 (fixedModelId を持つもの) は全て `defaultUrl` を持つ。`unsloth` は `defaultApiKey: 'sk-unsloth-local'`。
  - `local: true` はローカル系 6 つ (lmstudio / unsloth / ollama / vllm / llamacpp / openai-compatible)。
- 定数を追加: `OLLAMA_ID` / `VLLM_ID` / `LLAMACPP_ID` / `OPENAI_COMPATIBLE_ID` と各 `*_DEFAULT_URL`。
- `PROVIDERS` の並び: anthropic, openai, lmstudio, ollama, vllm, llamacpp, unsloth, openai-compatible。
- 新関数 `customEndpointProviders(): readonly ArschatProviderDescriptor[]` (fixedModelId を持つもの) と
  `defaultCustomEndpointFor(kind): CustomOpenAiModelEntry | undefined` を export
  (返すのは `{ id, model: 'local-model', url: defaultUrl, apiKey?: defaultApiKey, enableStreaming: true, developerMessageSettings: 'system' }`。apiKey は defaultApiKey がある時だけ付ける)。
  `CustomOpenAiModelEntry` 型は provider-switch-service.ts と seed で重複定義されているので、この関数と一緒に preferences.ts へ寄せ、両方から import する形にしてよい (provider-switch-service.ts からの re-export は残す。arschat-chat のテストが import している可能性があるため)。
- 先頭コメントの「four providers」記述を実態に合わせて更新。

### 1-2. `arschat-providers/src/browser/provider-switch-service.ts`
- `customEndpointIdFor(kind)`: `lmstudio`/`unsloth` のハードコードをやめ、`providerByKind(kind)?.fixedModelId` をそのまま返す。
- `defaultCustomEndpoint(kind)`: `defaultCustomEndpointFor(kind)` に委譲 (lmstudio/unsloth の結果は今と完全一致すること)。
- import から不要になった定数を除く。他のロジック (チェーン直列化など) は触らない。

### 1-3. `arschat-providers/src/browser/arschat-providers-seed-contribution.ts`
- 個別 if をやめ、`customEndpointProviders()` を回して未登録 id だけ `defaultCustomEndpointFor` で追加する。既存エントリは絶対に上書きしない。
- ログ文言の `(lmstudio/unsloth)` を一般化。

### 1-4. `arschat-providers/src/browser/arschat-m2-autotest-contribution.ts`
- `liveTestProvider` の lmstudio/unsloth 分岐を一般化: fixedModelId を持つプロバイダは `switchService.getCustomEndpointUrl(kind)` の `/models` を probe。unsloth の `:8888` フォールバックだけは残す。
- 先頭コメントの「all 4 providers」を更新。

### 1-5. 新規: `arschat-providers/src/browser/arschat-local-llm-autotest-contribution.ts`
`ARSCHAT_LOCAL_LLM_AUTOTEST=1` の時だけ動く実機検証 (M2 autotest と同じく `EnvVariablesServer` で backend env を読む。未設定なら完全 no-op)。
- env: `ARSCHAT_LOCAL_LLM_PROVIDER` (既定 `vllm`)、`ARSCHAT_LOCAL_LLM_URL` (既定はそのプロバイダの defaultUrl)、`ARSCHAT_LOCAL_LLM_MODEL` (任意。未指定なら /models の先頭)。
- 起動 ~10 秒後 (他の autotest と同様 setTimeout) に以下を順に実行し、`[LOCAL-LLM][autotest]` プレフィックスで console.log。各シナリオ PASS/FAIL、最後に `SUMMARY n PASS / m FAIL`。
  1. `endpoint`: `switchService.updateCustomEndpointUrl(kind, url)` → 正規化 URL をログ。
  2. `models`: `switchService.fetchCustomEndpointModels(kind, { timeoutMs: 10000 })` が 1 件以上返す。
  3. `select`: `switchService.setActive(kind, model)` の戻り値の `modelId === kind` かつ `provider === kind`。その後 `LanguageModelRegistry.getLanguageModels()` に id === kind のモデルが現れるまで最大 10 秒ポーリング (custom model の再登録は preference 変更に反応して非同期で起きる)。
  4. `pong`: M2 の `roundTrip()` と同じ方法 (ArsChat エージェントでセッション作成 → `chatService.sendRequest`) で `Reply with exactly: PONG` を送り、返答に `PONG` を含む。タイムアウト 120 秒。
  5. `japanese`: `日本の首都を漢字2文字で答えてください。` を送り、返答に `東京` を含む。タイムアウト 120 秒。
- 返答テキストの取り出しは M2 の `roundTrip` と同じ (`asString?.() ?? asDisplayString?.()`)。共通化したければ小さなヘルパー関数に切り出してよい。
- `arschat-providers-frontend-module.ts` で `FrontendApplicationContribution` として bind (M2 autotest の bind の隣)。

### 1-6. `arschat-tools/src/browser/arschat-m5-live-contribution.ts` (小変更)
- env `ARSCHAT_M5_LIVE_PROVIDER` (既定 `lmstudio`) を追加。値は fixedModelId を持つプロバイダ kind のみ許可 (不正なら FAIL ログを出して終了)。
- これまで `LMSTUDIO_ID` 固定だった箇所 (エンドポイント書き換え・LanguageModel 検索・requirement 設定・ログ) を選ばれたプロバイダの id に置き換える。既定値のままなら挙動は今と同一。
- `ARSCHAT_M5_LIVE_URL` / `ARSCHAT_M5_LIVE_MODEL` の意味は変えない。

### 1-7. UI (`arschat-chat/src/browser/arschat-chat-widget.tsx`)
- `PROVIDERS` を map しているので選択肢は自動で増える。`isCustomEndpointProvider` も fixedModelId 判定なので接続先 URL 欄・モデルのライブ取得も自動で効くはず。**コード変更が不要ならしない**。
- 1 箇所だけ: provider `<select>` の option 表示で、`local: true` のプロバイダは `<optgroup label='ローカル'>`、それ以外は `<optgroup label='クラウド'>` にまとめる (表示順は PROVIDERS の順を維持)。

## 2. テスト (jest)

既存: `arschat-chat/src/browser/arschat-chat-widget.test.ts` が ProviderSwitchService を直接 new してテストしている (750-1000 行付近)。この流儀で追加する。
- `defaultCustomEndpointFor` が lmstudio / unsloth で従来と同じオブジェクトを返す (unsloth は apiKey `sk-unsloth-local`)。
- 新 4 プロバイダの defaultCustomEndpointFor が表 0 の URL を返し、apiKey を持たない。
- `ProviderSwitchService.getCustomEndpointUrl('ollama')` が preference 未設定時に `http://localhost:11434/v1`。
- `updateCustomEndpointUrl('vllm', 'http://192.168.1.149:8000')` が `customOpenAiModels` に `{ id: 'vllm', url: 'http://192.168.1.149:8000/v1' }` を書く (lmstudio エントリは保持)。
- `setActive('ollama', 'qwen3:8b')` → `{ provider: 'ollama', model: 'qwen3:8b', modelId: 'ollama' }`。
- seed: 既存配列に lmstudio だけある状態で onStart → 残り 5 つが追加され、lmstudio は元のまま (seed のテストファイルは新規で `arschat-providers` 側に作ってもよいが、arschat-providers に jest 設定が無ければ arschat-chat 側のテストに置く)。
- 既存テストは全て通ること。既存テストの期待値を書き換えて通すのは禁止 (挙動を変えない約束のため)。

## 3. 完了条件 (実装者が自分で確認すること)

1. `npm --prefix arschat-providers run build`、`npm --prefix arschat-tools run build`、`npm --prefix arschat-chat run build` が tsc エラー 0。
2. `npm --prefix arschat-chat test` と `npm --prefix arschat-tools test` が全 green。
3. `git diff --stat` で変更が上記ファイル + 新規テスト/autotest ファイルに収まっていること。node_modules・lib・electron-app/browser-app の生成物には触らない。
4. コミットはしない (指揮側が検証後にコミットする)。

## 4. やらないこと

- Theia 本体 (node_modules) の改変。
- API キー入力 UI の追加 (キーは settings の customOpenAiModels に直接書く運用のまま。ms-9 で別途扱う)。
- `reasoning_content` (llama.cpp の deepseek 形式など) の対応。Theia の iterator が拾わないため、llama.cpp は `--reasoning-format none` で起動して `<think>` タグを本文に流す運用を BUILD_NOTES に書く (指揮側で書く)。
- Ollama ネイティブ API (`@theia/ai-ollama`) の導入。OpenAI 互換 `/v1` で統一する。
