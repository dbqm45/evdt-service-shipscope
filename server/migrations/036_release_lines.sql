-- Release lines (G1.3, pdi contract 0.4.0 "Konwencje"): which line R1…Rn of a release plan each work item belongs
-- to (R1 = the MVP), and which flags commits put work items behind.
--
-- jira_connections.release_link: how the tenant's Jira issues name their line, like flag_link (014):
--   {"type":"label","prefix":"release:"}            labels like release:R1 (the default),
--   {"type":"fixVersion","prefix":""}               a fixVersion named R1 (after the prefix),
--   {"type":"field","id":"customfield_10060","name":"Release line"}  a text or select field holding R1,
--   {"type":"none"}                                  no lines from Jira.
ALTER TABLE jira_connections
    ADD COLUMN release_link jsonb NOT NULL DEFAULT '{"type":"label","prefix":"release:"}';

-- One line per work item, written by the Jira sync (origin 'jira'); 'repo' is kept for plans read from
-- changes/CHG-n/release.yaml, which come later.
CREATE TABLE release_lines (
    tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    item_key text NOT NULL CHECK (item_key ~ '^[A-Z][A-Z0-9_]*-[0-9]+$'),
    release text NOT NULL CHECK (release ~ '^R[0-9]{1,4}$'),
    origin text NOT NULL CHECK (origin IN ('jira', 'repo')),
    synced_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, item_key)
);

-- `Flag: <key>` in a commit message (tf talos-story-run, next to `Change: TSK-n`): the flag and the work items that
-- same commit names. A strong link, merged with the sender's, the hand-set and Jira's own (lib/flags.js); an admin's
-- dismissal of a key (flags.dismissed_jira_keys) still wins.
CREATE TABLE flag_commit_links (
    tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    flag_key text NOT NULL,
    item_key text NOT NULL,
    repo_id bigint NOT NULL,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, flag_key, item_key)
);

ALTER TABLE release_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY release_lines_tenant_all ON release_lines
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE flag_commit_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE flag_commit_links FORCE ROW LEVEL SECURITY;
CREATE POLICY flag_commit_links_tenant_all ON flag_commit_links
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
