CREATE TABLE "ingestion_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"record_key" text NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_record_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"record_key" text NOT NULL,
	"canonical_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"last_run_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"adapter_version" text NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"status" text NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"entity_kind" text NOT NULL,
	"external_id" text NOT NULL,
	"internal_id" uuid NOT NULL,
	"created_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_roster_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"player_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"organization_id" uuid,
	"observed_at" timestamp with time zone NOT NULL,
	"run_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"snapshot_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source_url" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ingestion_issues" ADD CONSTRAINT "ingestion_issues_run_id_ingestion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_record_state" ADD CONSTRAINT "ingestion_record_state_last_run_id_ingestion_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_snapshot_id_source_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."source_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_identities" ADD CONSTRAINT "source_identities_created_run_id_ingestion_runs_id_fk" FOREIGN KEY ("created_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_roster_observations" ADD CONSTRAINT "source_roster_observations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_roster_observations" ADD CONSTRAINT "source_roster_observations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_roster_observations" ADD CONSTRAINT "source_roster_observations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_roster_observations" ADD CONSTRAINT "source_roster_observations_run_id_ingestion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_record_source_key" ON "ingestion_record_state" USING btree ("provider","record_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_canonical_owner" ON "ingestion_record_state" USING btree ("canonical_key");--> statement-breakpoint
CREATE INDEX "ingestion_run_provider" ON "ingestion_runs" USING btree ("provider","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_identity_external" ON "source_identities" USING btree ("provider","entity_kind","external_id");--> statement-breakpoint
CREATE INDEX "source_identity_internal" ON "source_identities" USING btree ("entity_kind","internal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roster_observation_source" ON "source_roster_observations" USING btree ("provider","player_id","team_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_snapshot_revision" ON "source_snapshots" USING btree ("provider","snapshot_key","content_hash","observed_at");