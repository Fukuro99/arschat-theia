// 統合デモ (5-1 + 5-2): GraphRAG 最小パイプライン
//   1. 各ノードにダミー埋め込みベクターを付与し vec0 に格納
//   2. クエリベクターで KNN 検索 -> エントリノードを1つ特定
//   3. エントリノードから再帰CTEで 2-hop 展開
//   4. 展開されたノード群の content を「文脈テキスト」として収集し出力
//
// 1つの SQLite ファイルに vec0 仮想テーブルと nodes/edges 通常テーブルを同居させる。
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");

const DIM = 384;
const DB_PATH = path.join(__dirname, "..", "data", "5-3-integrated.db");

const NODES = [
  { id: 1, label: "ArsChat", content: "デスクトップAIチャットアプリ" },
  { id: 2, label: "Electron", content: "デスクトップアプリフレームワーク" },
  { id: 3, label: "React", content: "UIライブラリ" },
  { id: 4, label: "TypeScript", content: "型付きJavaScript" },
  { id: 5, label: "Neo4j", content: "グラフDB(廃止検討中)" },
  { id: 6, label: "SQLite", content: "組み込みRDB" },
  { id: 7, label: "better-sqlite3", content: "SQLiteのNode.jsバインディング" },
  { id: 8, label: "sqlite-vec", content: "SQLite用ベクター検索拡張" },
  { id: 9, label: "GraphRAG", content: "グラフ+ベクター検索によるRAG手法" },
  { id: 10, label: "UserMemory", content: "ユーザーメモリ機能。会話から抽出した事実を保存する" },
  { id: 11, label: "Claude", content: "Anthropic製LLM" },
  { id: 12, label: "MCP", content: "Model Context Protocol" },
  { id: 13, label: "Theia", content: "拡張可能なIDEフレームワーク" },
  { id: 14, label: "VSCodeExtension", content: "VS Code互換拡張機能" },
  { id: 15, label: "Vite", content: "フロントエンドビルドツール" },
  { id: 16, label: "Biome", content: "リンター/フォーマッター" },
  { id: 17, label: "MainProcess", content: "Electronメインプロセス" },
  { id: 18, label: "RendererProcess", content: "Electronレンダラープロセス" },
  { id: 19, label: "IPC", content: "プロセス間通信" },
  { id: 20, label: "WebSearchTool", content: "DuckDuckGo検索ツール" },
  { id: 21, label: "FetchPageTool", content: "ページ取得ツール" },
  { id: 22, label: "RunCommandTool", content: "シェルコマンド実行ツール" },
  { id: 23, label: "ApprovalDialog", content: "実行前承認ダイアログ" },
  { id: 24, label: "MemoryGraphView", content: "メモリのグラフ可視化UI" },
  { id: 25, label: "TaskChatView", content: "タスク専用チャットUI" },
  { id: 26, label: "vec0", content: "sqlite-vecの仮想テーブルモジュール" },
  { id: 27, label: "RecursiveCTE", content: "SQLの再帰的共通テーブル式" },
  { id: 28, label: "KNNSearch", content: "K近傍探索" },
  { id: 29, label: "EmbeddingVector", content: "埋め込みベクター" },
  { id: 30, label: "KnowledgeGraph", content: "知識グラフ" },
];

const EDGES = [
  [1, 2, "built_with"], [1, 3, "built_with"], [1, 4, "built_with"],
  [1, 10, "has_feature"], [1, 11, "uses"], [1, 20, "has_feature"],
  [1, 22, "has_feature"], [10, 5, "currently_uses"], [10, 6, "candidate_backend"],
  [6, 7, "accessed_via"], [7, 8, "loads_extension"], [8, 26, "provides"],
  [8, 28, "enables"], [9, 8, "depends_on"], [9, 27, "depends_on"],
  [9, 29, "operates_on"], [9, 30, "operates_on"], [10, 9, "candidate_architecture"],
  [30, 27, "queried_via"], [28, 29, "operates_on"], [2, 17, "has"], [2, 18, "has"],
  [17, 19, "communicates_via"], [18, 19, "communicates_via"], [3, 18, "runs_in"],
  [4, 3, "types_for"], [1, 15, "built_with"], [1, 16, "uses_tool"],
  [13, 14, "supports"], [1, 13, "considering_migration_to"],
  [20, 21, "related_to"], [22, 23, "requires"], [10, 24, "visualized_by"],
  [1, 25, "has_feature"], [25, 11, "uses"], [5, 30, "is_a"], [6, 30, "candidate_for"],
];

// 決定的擬似乱数(mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ラベル文字列から決定的にシード値を作る(同じラベルなら常に同じベクター)
function seedFromString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h;
}

function embed(text, dim = DIM) {
  const rand = mulberry32(seedFromString(text));
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = rand() * 2 - 1;
  return v;
}

function buildDb() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const db = new Database(DB_PATH);
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE edges (
      src INTEGER NOT NULL,
      dst INTEGER NOT NULL,
      relation TEXT NOT NULL
    );
    CREATE INDEX idx_edges_src ON edges(src);
    CREATE INDEX idx_edges_dst ON edges(dst);
    CREATE VIRTUAL TABLE vec_nodes USING vec0(
      id INTEGER PRIMARY KEY,
      embedding float[${DIM}]
    );
  `);

  const insertNode = db.prepare(
    "INSERT INTO nodes (id, label, content) VALUES (@id, @label, @content)"
  );
  const insertEdge = db.prepare(
    "INSERT INTO edges (src, dst, relation) VALUES (?, ?, ?)"
  );
  const insertVec = db.prepare(
    "INSERT INTO vec_nodes (id, embedding) VALUES (?, ?)"
  );

  const tx = db.transaction(() => {
    for (const n of NODES) {
      insertNode.run(n);
      // label+content を結合してダミー埋め込みを生成(実際は埋め込みモデルの出力を使う想定)
      const v = embed(`${n.label} ${n.content}`);
      insertVec.run(BigInt(n.id), Buffer.from(v.buffer));
    }
    for (const [src, dst, relation] of EDGES) insertEdge.run(src, dst, relation);
  });
  tx();

  return db;
}

function khopNeighbors(db, startId, k) {
  return db
    .prepare(
      `
    WITH RECURSIVE khop(id, depth) AS (
      SELECT ?, 0
      UNION
      SELECT
        CASE WHEN e.src = khop.id THEN e.dst ELSE e.src END,
        khop.depth + 1
      FROM khop
      JOIN edges e ON e.src = khop.id OR e.dst = khop.id
      WHERE khop.depth < ?
    )
    SELECT DISTINCT n.id, n.label, n.content, MIN(khop.depth) AS min_depth
    FROM khop
    JOIN nodes n ON n.id = khop.id
    GROUP BY n.id
    ORDER BY min_depth, n.id
  `
    )
    .all(startId, k);
}

function main() {
  console.log("=== 統合デモ: GraphRAG 最小パイプライン ===");
  console.log("  クエリベクター -> vec0 KNNでエントリノード特定 -> 再帰CTEで2-hop展開 -> 文脈収集\n");

  const db = buildDb();
  console.log(`グラフ規模: ノード${NODES.length}件 / エッジ${EDGES.length}件 / 埋め込み次元${DIM}`);

  // ユーザークエリ(自然文の代わりにキーワードで擬似embedding。
  // 実運用では実際の埋め込みモデルでベクター化する)
  const userQuery = "UserMemory ユーザーメモリ機能。会話から抽出した事実を保存する";
  const queryVec = embed(userQuery);
  console.log(`\nユーザークエリ(擬似): "${userQuery}"`);

  // Step 1: vec0 で最も近いエントリノードを1件特定
  const [entry] = db
    .prepare(
      `
    SELECT v.id, v.distance, n.label, n.content
    FROM vec_nodes v
    JOIN nodes n ON n.id = v.id
    WHERE v.embedding MATCH ? AND k = 1
    ORDER BY v.distance
  `
    )
    .all(Buffer.from(queryVec.buffer));

  console.log(
    `\n[Step1: KNN検索] エントリノード特定 -> id=${entry.id} label=${entry.label} distance=${entry.distance.toFixed(6)}`
  );

  // Step 2: エントリノードから2-hop展開
  const k = 2;
  const neighborhood = khopNeighbors(db, entry.id, k);
  console.log(
    `\n[Step2: 再帰CTE] id=${entry.id} から k=${k} hop 展開 -> ${neighborhood.length}ノード取得`
  );
  for (const row of neighborhood) {
    console.log(`  depth=${row.min_depth}  ${row.label}`);
  }

  // Step 3: 文脈テキスト収集(depth順に整形し、LLMへ渡すプロンプト断片を模する)
  const contextLines = neighborhood.map(
    (row) => `- [${row.label}] (${row.min_depth}hop) ${row.content}`
  );
  const contextText = contextLines.join("\n");

  console.log("\n[Step3: 文脈テキスト収集結果]");
  console.log("----------------------------------------");
  console.log(contextText);
  console.log("----------------------------------------");

  // 健全性チェック
  const entryIsUserMemory = entry.label === "UserMemory";
  const containsNeo4jAndSqlite =
    neighborhood.some((r) => r.label === "Neo4j") &&
    neighborhood.some((r) => r.label === "SQLite");
  console.log(
    `\n判定: エントリノードがクエリ内容(UserMemory)と一致 -> ${entryIsUserMemory ? "PASS" : "FAIL"}`
  );
  console.log(
    `判定: 2-hop文脈にNeo4jとSQLiteの両方が含まれる(移行検討の文脈が拾える) -> ${containsNeo4jAndSqlite ? "PASS" : "FAIL"}`
  );

  db.close();
  console.log(`\nDBファイル: ${DB_PATH}`);
  process.exit(entryIsUserMemory && containsNeo4jAndSqlite ? 0 : 1);
}

main();
