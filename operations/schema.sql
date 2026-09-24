CREATE SCHEMA IF NOT EXISTS brewit;
CREATE TABLE IF NOT EXISTS brewit.settings (
  id integer PRIMARY KEY CHECK(id=1), mode text NOT NULL DEFAULT 'preparation' CHECK(mode='preparation'),
  closed_through timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO brewit.settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS brewit.users (
  id uuid PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL,
  password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('director','admin','manager','operator','viewer')),
  locations jsonb NOT NULL DEFAULT '[]', active boolean NOT NULL DEFAULT true,
  totp_secret text, totp_last_step bigint, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS brewit.sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES brewit.users,
  csrf text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS brewit.login_attempts (
  key text PRIMARY KEY, attempts integer NOT NULL, reset_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS brewit.enrollments (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL UNIQUE REFERENCES brewit.users,
  expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS brewit.master_imports (
  id uuid PRIMARY KEY, source_hash text NOT NULL UNIQUE, observed_at timestamptz NOT NULL,
  source jsonb NOT NULL, report jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS brewit.master_import_rows (
  id uuid PRIMARY KEY, import_id uuid NOT NULL REFERENCES brewit.master_imports,
  kind text NOT NULL, code text NOT NULL, original jsonb NOT NULL, proposal jsonb,
  issues jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted')),
  accepted_by uuid REFERENCES brewit.users, accepted_at timestamptz, UNIQUE(import_id,kind,code)
);
CREATE TABLE IF NOT EXISTS brewit.warehouses (
  id text PRIMARY KEY, location text NOT NULL, name text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('operating','transit','waste')), active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS brewit.items (
  id uuid PRIMARY KEY, code text UNIQUE NOT NULL, version integer NOT NULL,
  body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS brewit.item_versions (
  item_id uuid NOT NULL REFERENCES brewit.items, version integer NOT NULL,
  effective_at timestamptz NOT NULL, body jsonb NOT NULL, author uuid NOT NULL REFERENCES brewit.users,
  PRIMARY KEY(item_id,version)
);
CREATE TABLE IF NOT EXISTS brewit.external_codes (
  location text NOT NULL CHECK(location IN ('store-1','store-2')),
  external_code text NOT NULL, item_id uuid NOT NULL REFERENCES brewit.items,
  PRIMARY KEY(location,external_code)
);
CREATE TABLE IF NOT EXISTS brewit.suppliers (
  id uuid PRIMARY KEY, code text UNIQUE NOT NULL, body jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS brewit.documents (
  id uuid PRIMARY KEY, kind text NOT NULL, location text NOT NULL, effective_at timestamptz NOT NULL,
  status text NOT NULL CHECK(status IN ('draft','submitted','posted','reversed')),
  version integer NOT NULL DEFAULT 1, body jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES brewit.users, posted_by uuid REFERENCES brewit.users,
  posted_at timestamptz, reversed_by uuid REFERENCES brewit.documents,
  request_key text UNIQUE NOT NULL, request_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS document_sale_identity ON brewit.documents(location,(body->>'orderId')) WHERE kind='sale';
CREATE TABLE IF NOT EXISTS brewit.movements (
  id bigserial PRIMARY KEY, document_id uuid NOT NULL REFERENCES brewit.documents,
  item_id uuid NOT NULL REFERENCES brewit.items, warehouse text NOT NULL REFERENCES brewit.warehouses,
  lot text NOT NULL DEFAULT '', quantity numeric(28,8) NOT NULL, value numeric(28,8) NOT NULL,
  effective_at timestamptz NOT NULL, item_version integer NOT NULL, metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS movements_balance ON brewit.movements(warehouse,item_id,effective_at);
CREATE TABLE IF NOT EXISTS brewit.balances (
  warehouse text NOT NULL REFERENCES brewit.warehouses, item_id uuid NOT NULL REFERENCES brewit.items,
  quantity numeric(28,8) NOT NULL DEFAULT 0, value numeric(28,8) NOT NULL DEFAULT 0,
  cost_pending boolean NOT NULL DEFAULT false,
  last_purchase_cost numeric(28,8), last_purchase_at timestamptz,
  PRIMARY KEY(warehouse,item_id)
);
ALTER TABLE brewit.balances ADD COLUMN IF NOT EXISTS cost_pending boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS brewit.lots (
  warehouse text NOT NULL REFERENCES brewit.warehouses, item_id uuid NOT NULL REFERENCES brewit.items,
  lot text NOT NULL, quantity numeric(28,8) NOT NULL DEFAULT 0, expires_on date,
  status text NOT NULL DEFAULT 'available' CHECK(status IN ('available','held','discarded')),
  PRIMARY KEY(warehouse,item_id,lot)
);
CREATE TABLE IF NOT EXISTS brewit.payables (
  id uuid PRIMARY KEY REFERENCES brewit.documents, supplier_id uuid NOT NULL REFERENCES brewit.suppliers,
  document_type text NOT NULL, number text NOT NULL, due_on date NOT NULL,
  total numeric(28,8) NOT NULL CHECK(total>0), paid numeric(28,8) NOT NULL DEFAULT 0 CHECK(paid>=0 AND paid<=total),
  UNIQUE(supplier_id,document_type,number)
);
CREATE TABLE IF NOT EXISTS brewit.issues (
  id bigserial PRIMARY KEY, document_id uuid REFERENCES brewit.documents, code text NOT NULL,
  details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
CREATE TABLE IF NOT EXISTS brewit.audit (
  id bigserial PRIMARY KEY, actor uuid REFERENCES brewit.users, action text NOT NULL,
  entity text NOT NULL, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION brewit.immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Append-only record'; END $$;
DROP TRIGGER IF EXISTS movements_immutable ON brewit.movements;
CREATE TRIGGER movements_immutable BEFORE UPDATE OR DELETE ON brewit.movements FOR EACH ROW EXECUTE FUNCTION brewit.immutable_record();
DROP TRIGGER IF EXISTS audit_immutable ON brewit.audit;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON brewit.audit FOR EACH ROW EXECUTE FUNCTION brewit.immutable_record();
DROP TRIGGER IF EXISTS versions_immutable ON brewit.item_versions;
CREATE TRIGGER versions_immutable BEFORE UPDATE OR DELETE ON brewit.item_versions FOR EACH ROW EXECUTE FUNCTION brewit.immutable_record();
CREATE OR REPLACE FUNCTION brewit.protect_posted_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('posted','reversed') THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Posted documents cannot be deleted'; END IF;
    IF NOT (OLD.status='posted' AND NEW.status='reversed' AND NEW.reversed_by IS NOT NULL
      AND (to_jsonb(OLD)-'status'-'reversed_by'-'version')=(to_jsonb(NEW)-'status'-'reversed_by'-'version'))
    THEN RAISE EXCEPTION 'Posted documents are immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS posted_document_immutable ON brewit.documents;
CREATE TRIGGER posted_document_immutable BEFORE UPDATE OR DELETE ON brewit.documents FOR EACH ROW EXECUTE FUNCTION brewit.protect_posted_document();

ALTER TABLE brewit.master_import_rows ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS brewit.hierarchies (
  kind text NOT NULL, code text NOT NULL, body jsonb NOT NULL,
  source_row uuid REFERENCES brewit.master_import_rows, approved_by uuid NOT NULL REFERENCES brewit.users,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(kind,code)
);
CREATE OR REPLACE FUNCTION brewit.protect_import_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.original IS DISTINCT FROM OLD.original OR NEW.import_id IS DISTINCT FROM OLD.import_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.code IS DISTINCT FROM OLD.code OR OLD.status='accepted'
  THEN RAISE EXCEPTION 'Imported originals and accepted reviews are immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS import_original_immutable ON brewit.master_import_rows;
CREATE TRIGGER import_original_immutable BEFORE UPDATE ON brewit.master_import_rows FOR EACH ROW EXECUTE FUNCTION brewit.protect_import_original();
