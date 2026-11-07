-- Synthetic fixture generated with pi-durable 1.0.2, pi-ai 1.0.3, chord 1.0.2.
-- Includes a workspace base/delta and an unscheduled task; no user data.
BEGIN TRANSACTION;
CREATE TABLE conversations (
		id INTEGER PRIMARY KEY,
		owner_conversation_id INTEGER,
		owner_task_id INTEGER,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT;
INSERT INTO "conversations" VALUES(1,NULL,NULL,'{"id":1}');
CREATE TABLE document_revisions (
		document_id INTEGER NOT NULL,
		seq INTEGER NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
		version INTEGER NOT NULL,
		content TEXT NOT NULL CHECK (json_valid(content)),
		PRIMARY KEY (document_id, seq)
	) STRICT;
INSERT INTO "document_revisions" VALUES(2,1,'base',1,'{}');
INSERT INTO "document_revisions" VALUES(3,1,'base',1,'{"items":[]}');
INSERT INTO "document_revisions" VALUES(4,1,'base',1,'{"models":{},"tools":{}}');
INSERT INTO "document_revisions" VALUES(5,1,'base',1,'{"sessionId":"01a1b5c5-3d80-7564-8ebe-cb2308889b40"}');
INSERT INTO "document_revisions" VALUES(6,1,'base',1,'{}');
INSERT INTO "document_revisions" VALUES(7,2,'base',1,'{"revision":0,"ideas":[],"projects":[],"memories":[],"tasks":[{"id":"legacy","title":"Legacy task","prompt":"migration needle","projectId":null,"cwd":"/synthetic","agent":"codex","mode":"research","status":"completed","createdAt":"2026-10-04T00:00:00.000Z","updatedAt":"2026-10-04T00:00:00.000Z","durableId":null,"threadId":"synthetic-thread","turnId":null,"result":"legacy answer","error":null,"events":[],"approvals":[],"artifact":null,"lastRequestId":"legacy","messages":[{"id":"legacy-message","role":"user","text":"migration needle"}]}],"requests":{},"queueTail":null}');
INSERT INTO "document_revisions" VALUES(7,3,'delta',1,'[["s",["revision"],1],["p",["memories"],0,0,[{"id":"fixture-memory","text":"synthetic persisted delta","createdAt":"2026-10-04T00:00:00.000Z"}]]]');
CREATE TABLE documents (
		id INTEGER PRIMARY KEY,
		kind TEXT NOT NULL,
		family INTEGER NOT NULL CHECK (family IN (0, 1)),
		key_value TEXT NOT NULL,
		scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
		owner_id INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		retired_at INTEGER,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT;
INSERT INTO "documents" VALUES(2,'"pi.live"',0,'""','conversation',1,1,NULL,'{"id":2,"kind":"pi.live","scope":{"kind":"conversation","conversationId":1},"history":"latest","fork":"initial","createdAt":1}');
INSERT INTO "documents" VALUES(3,'"pi.inbox"',0,'""','conversation',1,1,NULL,'{"id":3,"kind":"pi.inbox","scope":{"kind":"conversation","conversationId":1},"history":"latest","fork":"initial","createdAt":1}');
INSERT INTO "documents" VALUES(4,'"pi.usage"',0,'""','conversation',1,1,NULL,'{"id":4,"kind":"pi.usage","scope":{"kind":"conversation","conversationId":1},"history":"latest","fork":"initial","createdAt":1}');
INSERT INTO "documents" VALUES(5,'"pi.provider"',0,'""','conversation',1,1,NULL,'{"id":5,"kind":"pi.provider","scope":{"kind":"conversation","conversationId":1},"history":"latest","fork":"initial","createdAt":1}');
INSERT INTO "documents" VALUES(6,'"pi.agent"',0,'""','conversation',1,1,NULL,'{"id":6,"kind":"pi.agent","scope":{"kind":"conversation","conversationId":1},"history":"rewindable","fork":"asOf","createdAt":1}');
INSERT INTO "documents" VALUES(7,'"friday.workspace"',0,'""','session',0,2,NULL,'{"id":7,"kind":"friday.workspace","scope":{"kind":"session"},"createdAt":2}');
CREATE TABLE durable_metadata (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		next_id TEXT NOT NULL,
		next_seq INTEGER NOT NULL
	) STRICT;
INSERT INTO "durable_metadata" VALUES(1,'9',4);
CREATE TABLE durable_schema (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			version INTEGER NOT NULL CHECK (version >= 0)
		) STRICT;
INSERT INTO "durable_schema" VALUES(1,1);
CREATE TABLE entries (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		head INTEGER,
		commit_seq INTEGER NOT NULL,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT;
CREATE TABLE record_ids (
		id INTEGER PRIMARY KEY,
		record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
	) STRICT;
INSERT INTO "record_ids" VALUES(1,'conversation');
INSERT INTO "record_ids" VALUES(2,'document');
INSERT INTO "record_ids" VALUES(3,'document');
INSERT INTO "record_ids" VALUES(4,'document');
INSERT INTO "record_ids" VALUES(5,'document');
INSERT INTO "record_ids" VALUES(6,'document');
INSERT INTO "record_ids" VALUES(7,'document');
INSERT INTO "record_ids" VALUES(8,'task');
CREATE TABLE submissions (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		request_id TEXT,
		status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT;
CREATE TABLE tasks (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		kind TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
		abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
		background INTEGER NOT NULL CHECK (background IN (0, 1)),
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT;
INSERT INTO "tasks" VALUES(8,1,'"migration.fixture"','pending',0,0,'{"id":8,"conversationId":1,"kind":"migration.fixture","version":1,"input":{},"background":false,"abortRequested":false,"state":{"status":"pending","checkpoint":{"phase":"queued"}}}');
CREATE INDEX conversations_by_owner_conversation ON conversations (owner_conversation_id, id);
CREATE INDEX conversations_by_owner_task ON conversations (owner_task_id, id);
CREATE INDEX entries_by_conversation ON entries (conversation_id, id DESC);
CREATE INDEX entry_heads_by_conversation ON entries (conversation_id, id DESC) WHERE head IS NOT NULL;
CREATE INDEX tasks_by_status ON tasks (status, id);
CREATE INDEX tasks_by_conversation ON tasks (conversation_id, id);
CREATE INDEX tasks_by_kind ON tasks (kind, id);
CREATE INDEX tasks_by_abort_requested ON tasks (abort_requested, id);
CREATE INDEX tasks_by_background ON tasks (background, id);
CREATE INDEX submissions_by_request ON submissions (conversation_id, request_id);
CREATE INDEX submissions_by_conversation ON submissions (conversation_id, id);
CREATE INDEX submissions_by_status ON submissions (status, id);
CREATE INDEX documents_by_address
		ON documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at);
CREATE INDEX documents_by_scope ON documents (scope_kind, owner_id, id);
CREATE INDEX documents_by_scope_kind ON documents (scope_kind, owner_id, kind, id);
CREATE INDEX document_revisions_by_kind ON document_revisions (document_id, kind, seq DESC);
COMMIT;
