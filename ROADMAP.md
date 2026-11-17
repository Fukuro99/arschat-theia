# ArsChat (Theia 版) ロードマップ

残っている開発と、実装は済んでいて実機確認だけ残っている項目をここで管理する。
2026-11-17 に Beacon での管理をやめ、このファイルに一本化した。

- 過去のマイルストーン (ms-1〜ms-15) と各タスク (e-XX) の ID はコミットメッセージと `BUILD_NOTES.md` にそのまま残っている。
- 各マイルストーンの要求・設計判断は [docs/specs/](docs/specs/)、実装前の調査ブリーフは [docs/briefs/](docs/briefs/) にある。
- 実装メモ・検証結果は引き続き [BUILD_NOTES.md](BUILD_NOTES.md) に追記する。

## 完了済み

| ID | 内容 |
|---|---|
| ms-1 | PoC: Theia で独立チャットアプリが成立するか ([POC_PLAN.md](POC_PLAN.md)) |
| ms-2 | 5 ドメイン別 Theia 拡張への再編 |
| ms-3 | プロバイダ 4 種 (OpenAI / Anthropic / LM Studio / Unsloth) の切替 |
| ms-4 | 自前チャット UI (think 表示・画像添付・セッション永続化・履歴パネル) |
| ms-5 | ペルソナとスキル |
| ms-6 | AI ツール実行 (承認フロー付き) + MCP 接続 |
| ms-7 | IDE 再希釈とチャット UI 仕上げ |
| ms-8 | 編集・続きを生成・分岐 |
| ms-10 | 添付画像のプレビュー・個別削除・自動縮小 |
| ms-11 | 組み込みターミナル |
| ms-12 | Open VSX 拡張の検索・設置 |
| ms-13 | インタラクティブ UI (AI がチャット内に操作 UI を描画) |
| ms-14 | 独自拡張 (サンドボックス iframe + 権限ゲート API) |
| ms-15 | Explorer / Search / Outline の希釈解除 |

## 未着手の開発

- [ ] **ms-9: API キーを OS の金庫にしまう**
  - 今はプロバイダ設定の API キーが Theia の通常 preference に平文で残っている疑いがある。
  - Theia 同梱の OS キーチェーン連携 (Windows 資格情報マネージャー / macOS Keychain / libsecret) に載せ替える。
  - 完了条件: Windows 実機で保存・読み出しが動く (他 OS は未検証で可、その旨を BUILD_NOTES に記録)。
  - 経緯: ms-6 のストレッチ e-8 として一度スキップした。SPEC は未作成。
- [ ] **VS Code 拡張が出すビューが希釈から漏れる**
  - `electron-app/plugins/` の GitLens のビュー 3 つと、GitLens が実行時に呼び込む scm-view-container が左パネルに出る。
  - プラグイン由来のビューは FilterContribution (起動前除外) にも stale cleanup (初期化時走査) にも乗らないため、今の希釈の仕組みが構造的に効かない。
  - M6 autotest のシナリオ 2 (activity bar) はこの影響で FAIL のまま。詳細は BUILD_NOTES の ms-11 実装メモ。

## 後続 Phase に回した機能

[PHASE1_DESIGN.md](PHASE1_DESIGN.md) の非ゴールより。

- [ ] **Phase 2**: ユーザーメモリ GraphRAG の本組み込み (`poc-graphrag` の製品化)、チャット内メモリ
- [ ] **Phase 3**: タスク機能 (自律エージェント)、ウィジェットモードの製品化 (PoC-1 コードの仕上げ)
- [ ] 旧 ArsChat からのデータ移行ツール (セッション・設定のインポータ)
- [ ] 配布 (electron-builder、自動アップデート)

## 実機確認待ち

autotest は通っているが、人が実機で確かめる必要があるもの。確認できたら BUILD_NOTES に結果を書いてチェックを付ける。

- [ ] **ms-8 編集・分岐**: 実プロバイダでの編集→再生成の応答品質、再起動を跨いだ分岐セッションの永続化
- [ ] **ms-10 画像縮小**: 縮小後画像の実バイトサイズと画質、実 LM Studio での縮小画像の認識
- [ ] **ms-11 ターミナル**: 実コマンド (`dir` / `echo`) の実行と出力、日本語の表示・入力、既定シェルが cmd と PowerShell のどちらで開くか
- [ ] **ms-12 Open VSX**: Install 1 クリックで設置 → その場で有効化 → 再起動後も有効、純正 UI でのアンインストール・更新
- [ ] **ms-13 インタラクティブ UI**: 実 LLM でのフォーム描画〜ライブ往復、CSP による外部通信遮断の実ネットワーク観測、ライト/ダークテーマ追従
- [ ] **ms-14 独自拡張**: electron 版で左パネルに「ArsChat 拡張」ビューが出る、権限確認ダイアログの実表示と再起動後の承認保持、実在の GitHub リポジトリからの設置
- [ ] **ms-15 Explorer など**: フォルダを開く → ツリー表示 → 編集・保存、Search の検索と結果ジャンプ、Outline のシンボル表示、通常終了後の再起動でフォルダとレイアウトが復元される
