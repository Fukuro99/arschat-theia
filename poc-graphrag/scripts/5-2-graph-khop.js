// PoC-5-2: nodes(id, label, content) / edges(src, dst, relation) テーブルで
// 30ノード程度の知識グラフを構築し、再帰CTEで指定ノードからの
// k-hop 近傍探索 (k=2) が動くことを確認する。
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "..", "data", "5-2-graph.db");

// 30ノードの小さな知識グラフ(木構造 + 横断エッジを少し混ぜる)
// テーマ: ArsChat の技術構成要素を題材にしたダミーグラフ
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
  { id: 10, label: "UserMemory", content: "ユーザーメモリ機能" },
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
  [1, 2, "built_with"],
  [1, 3, "built_with"],
  [1, 4, "built_with"],
  [1, 10, "has_feature"],
  [1, 11, "uses"],
  [1, 20, "has_feature"],
  [1, 22, "has_feature"],
  [10, 5, "currently_uses"],
  [10, 6, "candidate_backend"],
  [6, 7, "accessed_via"],
  [7, 8, "loads_extension"],
  [8, 26, "provides"],
  [8, 28, "enables"],
  [9, 8, "depends_on"],
  [9, 27, "depends_on"],
  [9, 29, "operates_on"],
  [9, 30, "operates_on"],
  [10, 9, "candidate_architecture"],
  [30, 27, "queried_via"],
  [28, 29, "operates_on"],
  [2, 17, "has"],
  [2, 18, "has"],
  [17, 19, "communicates_via"],
  [18, 19, "communicates_via"],
  [3, 18, "runs_in"],
  [4, 3, "types_for"],
  [1, 15, "built_with"],
  [1, 16, "uses_tool"],
  [13, 14, "supports"],
  [1, 13, "considering_migration_to"], // Theia移行PoCとの関連づけ(横断エッジ)
  [20, 21, "related_to"],
  [22, 23, "requires"],
  [10, 24, "visualized_by"],
  [1, 25, "has_feature"],
  [25, 11, "uses"],
  [5, 30, "is_a"],
  [6, 30, "candidate_for"],
];

function buildDb() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE edges (
      src INTEGER NOT NULL,
      dst INTEGER NOT NULL,
      relation TEXT NOT NULL,
      FOREIGN KEY (src) REFERENCES nodes(id),
      FOREIGN KEY (dst) REFERENCES nodes(id)
    );
    CREATE INDEX idx_edges_src ON edges(src);
    CREATE INDEX idx_edges_dst ON edges(dst);
  `);

  const insertNode = db.prepare(
    "INSERT INTO nodes (id, label, content) VALUES (@id, @label, @content)"
  );
  const insertEdge = db.prepare(
    "INSERT INTO edges (src, dst, relation) VALUES (?, ?, ?)"
  );

  const tx = db.transaction(() => {
    for (const n of NODES) insertNode.run(n);
    for (const [src, dst, relation] of EDGES) insertEdge.run(src, dst, relation);
  });
  tx();

  return db;
}

// 再帰CTEによる k-hop 近傍探索(無向グラフとして扱う: src->dst, dst->src 両方向)
function khopNeighbors(db, startId, k) {
  const rows = db
    .prepare(
      `
    WITH RECURSIVE khop(id, depth, path) AS (
      SELECT ?, 0, CAST(? AS TEXT)
      UNION
      SELECT
        CASE WHEN e.src = khop.id THEN e.dst ELSE e.src END,
        khop.depth + 1,
        khop.path || '->' || CASE WHEN e.src = khop.id THEN e.dst ELSE e.src END
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
    .all(startId, startId, k);
  return rows;
}

function main() {
  console.log("=== PoC-5-2: 再帰CTEによる k-hop 近傍探索 ===");
  const db = buildDb();
  console.log(`ノード数: ${NODES.length} / エッジ数: ${EDGES.length}`);

  const startId = 10; // UserMemory を起点にする
  const k = 2;
  const result = khopNeighbors(db, startId, k);

  const start = NODES.find((n) => n.id === startId);
  console.log(
    `\n起点ノード: id=${startId} label=${start.label} (${start.content})`
  );
  console.log(`k=${k} hop 近傍探索結果 (${result.length}件, 自身含む):`);
  for (const row of result) {
    console.log(
      `  depth=${row.min_depth}\tid=${row.id}\tlabel=${row.label}\t(${row.content})`
    );
  }

  // 期待値による健全性チェック:
  // depth=0: UserMemory自身
  // depth=1: Neo4j, SQLite, GraphRAG(candidate_architecture), MemoryGraphView, ArsChat(has_feature逆方向)
  // depth=2: それらの隣接ノード
  const depth0 = result.filter((r) => r.min_depth === 0).map((r) => r.label);
  const depth1 = result.filter((r) => r.min_depth === 1).map((r) => r.label);
  const expectedDepth1 = [
    "Neo4j",
    "SQLite",
    "GraphRAG",
    "MemoryGraphView",
    "ArsChat",
  ];
  const depth1Ok = expectedDepth1.every((l) => depth1.includes(l));
  const depth0Ok = depth0.length === 1 && depth0[0] === "UserMemory";

  console.log(
    `\n判定: depth=0 が起点自身のみ -> ${depth0Ok ? "PASS" : "FAIL"}`
  );
  console.log(
    `判定: depth=1 に期待ノード(${expectedDepth1.join(", ")})が全て含まれる -> ${depth1Ok ? "PASS" : "FAIL"}`
  );

  // k=1 と k=2 で結果件数が単調増加することも確認(グラフ探索の基本健全性)
  const k1 = khopNeighbors(db, startId, 1);
  const monotonic = result.length >= k1.length;
  console.log(
    `判定: k=2 の結果件数(${result.length}) >= k=1 の結果件数(${k1.length}) -> ${monotonic ? "PASS" : "FAIL"}`
  );

  db.close();
  console.log(`\nDBファイル: ${DB_PATH}`);
  process.exit(depth0Ok && depth1Ok && monotonic ? 0 : 1);
}

main();
