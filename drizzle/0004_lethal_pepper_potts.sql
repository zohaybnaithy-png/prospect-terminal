CREATE TABLE "player_batting_level_seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"level_code" text NOT NULL,
	"games" integer NOT NULL,
	"teams" integer NOT NULL,
	"runs" integer,
	"rbi" integer,
	"caught_stealing" integer,
	"sacrifice_bunts" integer,
	"catcher_interference" integer,
	"plate_appearances" integer DEFAULT 0 NOT NULL,
	"at_bats" integer DEFAULT 0 NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"doubles" integer DEFAULT 0 NOT NULL,
	"triples" integer DEFAULT 0 NOT NULL,
	"home_runs" integer DEFAULT 0 NOT NULL,
	"walks" integer DEFAULT 0 NOT NULL,
	"strikeouts" integer DEFAULT 0 NOT NULL,
	"hit_by_pitch" integer DEFAULT 0 NOT NULL,
	"sacrifice_flies" integer DEFAULT 0 NOT NULL,
	"stolen_bases" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_pitching_level_seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"level_code" text NOT NULL,
	"games" integer NOT NULL,
	"teams" integer NOT NULL,
	"runs" integer,
	"hit_batters" integer,
	"pitches" integer,
	"outs_recorded" integer DEFAULT 0 NOT NULL,
	"batters_faced" integer DEFAULT 0 NOT NULL,
	"hits_allowed" integer DEFAULT 0 NOT NULL,
	"earned_runs" integer DEFAULT 0 NOT NULL,
	"walks" integer DEFAULT 0 NOT NULL,
	"strikeouts" integer DEFAULT 0 NOT NULL,
	"home_runs_allowed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_batting_level_seasons" ADD CONSTRAINT "player_batting_level_seasons_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_batting_level_seasons" ADD CONSTRAINT "player_batting_level_seasons_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_pitching_level_seasons" ADD CONSTRAINT "player_pitching_level_seasons_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_pitching_level_seasons" ADD CONSTRAINT "player_pitching_level_seasons_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "batting_level_season" ON "player_batting_level_seasons" USING btree ("player_id","season_id","level_code");--> statement-breakpoint
CREATE UNIQUE INDEX "pitching_level_season" ON "player_pitching_level_seasons" USING btree ("player_id","season_id","level_code");