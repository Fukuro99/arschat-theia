# PoC-5: 組み込みGraphRAGスパイク

`POC_PLAN.md` の PoC-5 (ゲート外・後回し可) の検証コード。ArsChat の Neo4j 依存ユーザーメモリを、
**追加ダウンロード無し**の組み込み構成 (SQLite + sqlite-vec) で置き換えられるかの技術検証。

このディレクトリはスタンドアロンの npm パッケージとして完結しており、Theia アプリへの組み込みは
スコープ外(検証用の生 Node スクリプトのみ)。`arschat-theia` の他ディレクトリ(`electron-app` /
`arschat-core`)や `C:\Users\takep\source\ArsChat` には一切手を入れていない。

## 環境

- Node.js v24.14.1 / npm v11.11.0 (Windows 11 x64)
- `better-sqlite3` ^12.11.1
- `sqlite-vec` ^0.1.9 (実際に解決されたのは v0.1.9)

## セットアップ・実行

```bash
cd poc-graphrag
npm install
npm run poc:5-1        # ベクター類似検索 (vec0 + KNN)
npm run poc:5-2        # 再帰CTEによる k-hop グラフ探索
npm run poc:integrated # 統合デモ: KNN entry-node -> 2-hop展開 -> 文脈収集
```

## 結果サマリー

### 5-1: sqlite-vec ベクター類似検索 — **PASS**

`scripts/5-1-vector-search.js`。384次元・50件のダミー埋め込み(mulberry32による決定的擬似乱数、
seed=42)を vec0 仮想テーブルに投入し、`item-1` に微小ノイズを加えたクエリベクターで
`MATCH` 句によるKNN検索(k=5)を実行。

実行結果抜粋:

```
sqlite-vec version: v0.1.9
挿入件数: 50 件 (384次元 float32, seed=42 の決定的擬似乱数)

KNN検索結果 (query = item-1 + 微小ノイズ, k=5):
  id=1	label=item-1	distance=0.115465
  id=49	label=item-49	distance=14.861260
  ...
判定: 最近傍が item-1 (自分自身+ノイズ) である -> PASS
突合せ: sqlite-vec の1位とブルートフォースの1位が一致 -> PASS
```

JS側で愚直に計算したブルートフォース・コサイン距離の1位とも一致しており、`vec0` の
`MATCH ... AND k = N` によるKNN検索が正しく機能していることを確認した(sqlite-vec のデフォルト
距離関数はL2/ユークリッドのため、2位以降の順位はコサイン距離のランキングとは一致しないが、
これは想定通りの挙動)。

簡易パフォーマンス計測(5000件挿入 + KNN検索、384次元):

```
insert-5000: 40.03ms
knn-k10-on-5000: 1.881ms
```

ユーザーメモリ規模(数千件オーダー)であれば体感遅延なしで動く印象。

### 5-2: グラフ層(nodes/edges + 再帰CTE) — **PASS**

`scripts/5-2-graph-khop.js`。`nodes(id, label, content)` / `edges(src, dst, relation)` の2テーブルで
ArsChatの技術構成要素をテーマにした30ノード・37エッジの知識グラフを構築。`WITH RECURSIVE` で
無向グラフとして k=2 hop の近傍探索を実施。

実行結果抜粋(起点: `UserMemory`):

```
起点ノード: id=10 label=UserMemory (ユーザーメモリ機能)
k=2 hop 近傍探索結果 (21件, 自身含む):
  depth=0	id=10	label=UserMemory
  depth=1	id=1	label=ArsChat
  depth=1	id=5	label=Neo4j
  depth=1	id=6	label=SQLite
  depth=1	id=9	label=GraphRAG
  depth=1	id=24	label=MemoryGraphView
  depth=2	... (15ノード)

判定: depth=0 が起点自身のみ -> PASS
判定: depth=1 に期待ノード(Neo4j, SQLite, GraphRAG, MemoryGraphView, ArsChat)が全て含まれる -> PASS
判定: k=2 の結果件数(21) >= k=1 の結果件数(6) -> PASS
```

`MIN(depth)` によるグループ化で同一ノードへの複数経路の重複を排除し、深さ優先の期待通りの
展開順になることを確認した。

### 統合デモ(5-1+5-2): GraphRAG 最小パイプライン — **PASS**

`scripts/5-3-integrated-graphrag.js`。1つの SQLite ファイルに `vec0` 仮想テーブルと
`nodes`/`edges` 通常テーブルを同居させ、以下のパイプラインを1スクリプトで実行:

1. クエリテキストを擬似埋め込みベクター化(ラベル文字列ハッシュを種にした決定的疑似乱数。
   実運用では実際の埋め込みモデルの出力に置き換える想定)
2. `vec0` の KNN検索(k=1)でエントリノードを特定
3. エントリノードから再帰CTEで2-hop展開
4. 展開されたノード群の `content` を文脈テキストとして整形・収集

実行結果抜粋:

```
[Step1: KNN検索] エントリノード特定 -> id=10 label=UserMemory distance=0.000000
[Step2: 再帰CTE] id=10 から k=2 hop 展開 -> 21ノード取得
[Step3: 文脈テキスト収集結果]
- [UserMemory] (0hop) ユーザーメモリ機能。会話から抽出した事実を保存する
- [ArsChat] (1hop) デスクトップAIチャットアプリ
- [Neo4j] (1hop) グラフDB(廃止検討中)
- [SQLite] (1hop) 組み込みRDB
...
判定: エントリノードがクエリ内容(UserMemory)と一致 -> PASS
判定: 2-hop文脈にNeo4jとSQLiteの両方が含まれる(移行検討の文脈が拾える) -> PASS
```

「ベクター検索でエントリノードを当てて、グラフ構造で文脈を広げる」というGraphRAGの最小形が
単一の SQLite ファイル・単一プロセスで完結することを確認した。Neo4j + 別プロセスのベクターDBという
2階建て構成が不要になる。

## sqlite-vec の Windows プリビルト状況(「追加ダウンロード無し」要件)

**満たす。** `npm install` のみで Windows 用プリビルトバイナリが入る。

- `sqlite-vec` 本体パッケージは JS のローダーのみを含み、実体は `optionalDependencies` 経由で
  プラットフォーム別パッケージ(`sqlite-vec-windows-x64` 等)がインストールされる仕組み
  (`node_modules/sqlite-vec/index.cjs` 参照)。
- Windows x64 環境では `node_modules/sqlite-vec-windows-x64/vec0.dll` が **npm レジストリから
  直接取得したプリビルド済みネイティブDLL** としてそのまま配置される。追加のダウンロードスクリプト・
  外部インストーラ・ビルドツールは一切不要だった。
- 対応プラットフォームは `darwin-x64` / `darwin-arm64` / `linux-x64` / `linux-arm64` / `win32-x64` の
  5つ(`node_modules/sqlite-vec/index.cjs` の `supportedPlatforms` に定義)。**`win32-arm64`
  (Copilot+ PC 等の Arm版Windows) は現時点で非対応**。ArsChatのターゲット環境がArm版Windowsを
  含む場合は要注意。

### better-sqlite3 側の注意(sqlite-vec本体とは別問題)

sqlite-vecとは別に、**better-sqlite3自体のネイティブアドオンのプリビルド事情に環境依存の罠がある**
ことが分かった。

- better-sqlite3 は `prebuild-install || node-gyp rebuild --release` という install スクリプトで
  動作し、対応するプリビルドが無い場合は自動的にソースからのローカルコンパイル(node-gyp、
  つまりC++コンパイラ一式が必要)にフォールバックする。
- **`better-sqlite3` の v11系(執筆時点の最新 patch でも)は Node.js v24 (NODE_MODULE_VERSION /
  ABI = 137) 向けのプリビルドを提供しておらず**、`npm install` 時にプリビルド取得が404で失敗し
  node-gyp によるローカルビルドにフォールバックすることを実機で確認した
  (`node_modules/better-sqlite3/prebuilds` ディレクトリが生成されず、`build/Release/*.node` の
  タイムスタンプがインストール実行時刻と一致 = その場でコンパイルされたことを確認)。
  この問題は better-sqlite3 側のリポジトリでも既知(GitHub Issue
  [WiseLibs/better-sqlite3#1384](https://github.com/WiseLibs/better-sqlite3/issues/1384)、
  [#1376](https://github.com/WiseLibs/better-sqlite3/issues/1376))。
  この環境ではたまたま Visual Studio Build Tools (MSVC) が入っていたためビルドが通ったが、
  一般ユーザー環境(C++ビルドツール未導入)では **`npm install` が失敗する**。
- **回避策: `better-sqlite3` を v12系(このPoCでは `^12.11.1` に固定)にすると Node v24 向け
  プリビルドが提供されており、`npm install` だけでプリビルドDLLがそのまま入ることを実機で確認済み**
  (verboseログでコンパイラ呼び出し `CL.exe` が発生しないこと、`prebuild-install` が成功していることを確認)。
  → **「追加ダウンロード無し」要件を満たすには、better-sqlite3 を v12以降にピン留めすることが必須**。
    ArsChat/Theia側の想定 Node バージョンに応じて事前に prebuild 提供状況を都度確認する運用が必要
    (Node のメジャーバージョンが上がるたびに同種の問題が再発しうる)。

## Electron組み込み時の既知リスク(情報収集のみ、実機未検証)

`sqliteVec.load(db)` は内部で `better-sqlite3` の `db.loadExtension()` を呼び、OS別パッケージ内の
ネイティブ共有ライブラリ(Windowsなら `vec0.dll`)を `require.resolve` したパスから読み込む
(`node_modules/sqlite-vec/index.cjs` 実装より)。Electron組み込みで調査した限り、以下のリスクが
既知の問題として報告されている。

1. **ASAR パッケージング問題**: Electronアプリはデフォルトで `node_modules` を含むソース一式を
   `app.asar` という単一アーカイブファイルに固める。`better-sqlite3` や `sqlite-vec` のような
   ネイティブアドオン(`.node`/`.dll`)は ASAR 内から直接 `dlopen`/`LoadLibrary` できないため、
   `asarUnpack`(electron-builder)や `packagerConfig.asar.unpack`(electron-forge)で明示的に
   ASAR 展開対象に指定する必要がある。対応を忘れると起動時に拡張ロードが失敗する
   ([electron-userland/electron-builder#8824](https://github.com/electron-userland/electron-builder/issues/8824) で
   sqlite-vec そのものの事例が報告されている。二重拡張子 `vec0.dylib.dylib` を探しにいくパスの
   バグ報告もあり)。
2. **ネイティブモジュールのABI(NODE_MODULE_VERSION)不一致**: `better-sqlite3` はNodeとは別ABIの
   Electron向けに再ビルドする必要がある(`@electron/rebuild` 等でElectronのヘッダーに対して
   再コンパイル)。開発時にプレーンなNodeで動かした `.node` バイナリをそのままElectronで使うと
   「was compiled against a different Node.js version」エラーになる。CI/ビルドパイプラインに
   electron-rebuild相当のステップが必須。
3. **バンドラーとの相性**: Vite/webpack でメインプロセスをバンドルする場合、`better-sqlite3` を
   バンドル対象から除外(external化)しないと `.node` ファイルの解決に失敗する。
   `arschat-theia` の `electron-app` は Electron 39.8.7 を使用しており、上記1・2はほぼ確実に
   踏むことになる想定(このPoCの検証はNode単体で行っており、Electron実機での検証は範囲外)。
4. 上記はいずれも「対応すれば解決できる既知の問題」であり、致命的なブロッカーとは考えにくいが、
   PoC-1/2 のように rebind だけで済む話ではなく、ビルド設定(electron-builder/forge の asarUnpack +
   electron-rebuild 導入)の作業コストとして見積もる必要がある。

## Neo4j比で失われる機能・注意点

- **Cypherクエリ言語 / 高度なグラフアルゴリズム**: Neo4jはCypherによる宣言的パターンマッチングに加え、
  GDSライブラリ(PageRank、コミュニティ検出、最短経路の各種アルゴリズム、類似度アルゴリズム等)を
  標準/プラグインで提供する。SQLiteの再帰CTEはk-hop近傍探索や単純な経路探索は書けるが、
  重み付き最短経路(Dijkstra等)・中心性指標・コミュニティ検出のような分析系アルゴリズムは
  自前実装が必要になる。ユーザーメモリの用途(k-hop文脈収集程度)であれば影響は小さいが、
  「関連性の強いメモリ群をクラスタリングして要約する」のような高度な使い方をする場合は
  実装コストが増える。
- **ネイティブなグラフストレージ最適化の欠如**: Neo4jはグラフ専用のストレージエンジン(隣接リストの
  ポインタチェイシング)を持つため、深いホップ数や巨大グラフでの探索性能に強みがある。
  SQLiteの `nodes`/`edges` 通常テーブル+インデックスは今回程度の規模(30ノード、想定数千〜数万
  ノード)では十分高速だが、超大規模かつ深いトラバーサルが必要になった場合は再帰CTEの
  パフォーマンス劣化(中間結果の重複、インデックス頼みの結合コスト)に注意が必要。
- **トランザクション分離・同時実行性**: Neo4jはマルチクライアントの同時書き込みに強いが、SQLiteは
  基本的に単一プロセス・単一ライターのモデル(WALモードで複数リーダー+単一ライターは可能)。
  ArsChatはデスクトップアプリ(基本シングルユーザー・シングルプロセス)なのでこの制約はほぼ
  問題にならない想定。
- **ベクターインデックスの高度な機能**: sqlite-vecの `vec0` はブルートフォース(全件走査)の
  KNN実装であり、Neo4jのベクターインデックス(HNSW等の近似最近傍探索)のような
  対数オーダーのインデックス構造ではない。数千〜数万件規模なら実用上問題ないが
  (5000件でKNN検索1.9ms程度)、件数が数十万〜数百万件のオーダーに増えると線形劣化する点は
  留意が必要(sqlite-vec は概ね "small-to-medium" 規模を想定した設計)。
- **運用面でのプラス**: Neo4jは別プロセス(サーバー)としての起動・接続管理・バージョン整合性の
  運用コストがあったが、SQLiteはファイル1つで完結するため「追加ダウンロード無し」要件を
  自然に満たせる、バックアップ(ファイルコピー)やユーザー環境への配布が大幅に簡素化される、
  という明確なメリットがある。

## 結論(PoC-5としての Go/No-Go 材料)

- 5-1(sqlite-vec ベクター類似検索)、5-2(再帰CTEによるグラフ k-hop 探索)、統合デモともに
  **技術的に動作することを確認(PASS)**。
- 「追加ダウンロード無し」の要件は、**better-sqlite3 を v12系以降に固定する前提で** 満たせる
  (v11系のままだとNode v24環境でnpm installがローカルコンパイルにフォールバックし、
  C++ビルドツール無しの一般ユーザー環境では失敗しうる)。
- Electron組み込み時はASARアンパック設定とelectron-rebuildの導入が実質必須になる見込みだが、
  いずれも確立された解決策がある既知の問題であり、致命的なブロッカーではない
  (実機Electron環境での検証はこのPoCのスコープ外)。
- Neo4jから失われる主な機能は高度なグラフアルゴリズム(GDS)と近似最近傍検索(ANN)だが、
  ユーザーメモリのk-hop文脈収集という用途に対しては現状の規模感で十分実用に足ると判断できる。
