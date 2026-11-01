CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"abbreviation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "player_organization_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_membership_dates" CHECK ("player_organization_memberships"."ends_on" IS NULL OR "player_organization_memberships"."ends_on" >= "player_organization_memberships"."starts_on")
);
--> statement-breakpoint
ALTER TABLE "player_team_memberships" ADD COLUMN "assignment_type" text DEFAULT 'assignment' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "player_organization_memberships" ADD CONSTRAINT "player_organization_memberships_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_organization_memberships" ADD CONSTRAINT "player_organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_membership_player" ON "player_organization_memberships" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_membership_stint" ON "player_organization_memberships" USING btree ("player_id","organization_id","starts_on");--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;