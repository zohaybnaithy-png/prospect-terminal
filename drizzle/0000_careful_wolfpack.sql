CREATE TABLE "conferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"home_team_id" uuid NOT NULL,
	"away_team_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "different_teams" CHECK ("games"."home_team_id" <> "games"."away_team_id")
);
--> statement-breakpoint
CREATE TABLE "highlights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"game_id" uuid,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leagues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leagues_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "levels_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "news_item_players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"news_item_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"source" text NOT NULL,
	"url" text,
	"published_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_batting_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
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
CREATE TABLE "player_batting_seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
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
CREATE TABLE "player_pitching_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
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
CREATE TABLE "player_pitching_seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
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
CREATE TABLE "player_team_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"jersey_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_dates" CHECK ("player_team_memberships"."ends_on" IS NULL OR "player_team_memberships"."ends_on" >= "player_team_memberships"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"primary_position" text NOT NULL,
	"secondary_position" text,
	"bats" text,
	"throws" text,
	"birth_date" date,
	"external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospect_score_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"prospect_grade" numeric(5, 2) NOT NULL,
	"momentum" numeric(7, 2) NOT NULL,
	"model_version" text NOT NULL,
	"explanation" text,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "history_grade_range" CHECK ("prospect_score_history"."prospect_grade" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "prospect_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"prospect_grade" numeric(5, 2) NOT NULL,
	"momentum" numeric(7, 2) NOT NULL,
	"model_version" text NOT NULL,
	"explanation" text,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prospect_scores_player_id_unique" UNIQUE("player_id"),
	CONSTRAINT "current_grade_range" CHECK ("prospect_scores"."prospect_grade" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "rankings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"source" text NOT NULL,
	"rank" integer NOT NULL,
	"scope" text NOT NULL,
	"category" text NOT NULL,
	"as_of" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positive_rank" CHECK ("rankings"."rank" > 0)
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"year" integer NOT NULL,
	"name" text NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"level_id" uuid NOT NULL,
	"conference_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"abbreviation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "conferences" ADD CONSTRAINT "conferences_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_home_team_id_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_away_team_id_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlights" ADD CONSTRAINT "highlights_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlights" ADD CONSTRAINT "highlights_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "levels" ADD CONSTRAINT "levels_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_item_players" ADD CONSTRAINT "news_item_players_news_item_id_news_items_id_fk" FOREIGN KEY ("news_item_id") REFERENCES "public"."news_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_item_players" ADD CONSTRAINT "news_item_players_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_batting_games" ADD CONSTRAINT "player_batting_games_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_batting_games" ADD CONSTRAINT "player_batting_games_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_batting_games" ADD CONSTRAINT "player_batting_games_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_batting_seasons" ADD CONSTRAINT "player_batting_seasons_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_batting_seasons" ADD CONSTRAINT "player_batting_seasons_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_batting_seasons" ADD CONSTRAINT "player_batting_seasons_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_pitching_games" ADD CONSTRAINT "player_pitching_games_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_pitching_games" ADD CONSTRAINT "player_pitching_games_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_pitching_games" ADD CONSTRAINT "player_pitching_games_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_pitching_seasons" ADD CONSTRAINT "player_pitching_seasons_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_pitching_seasons" ADD CONSTRAINT "player_pitching_seasons_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_pitching_seasons" ADD CONSTRAINT "player_pitching_seasons_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_team_memberships" ADD CONSTRAINT "player_team_memberships_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_team_memberships" ADD CONSTRAINT "player_team_memberships_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_team_memberships" ADD CONSTRAINT "player_team_memberships_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_score_history" ADD CONSTRAINT "prospect_score_history_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_scores" ADD CONSTRAINT "prospect_scores_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rankings" ADD CONSTRAINT "rankings_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_level_id_levels_id_fk" FOREIGN KEY ("level_id") REFERENCES "public"."levels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "news_player" ON "news_item_players" USING btree ("news_item_id","player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batting_game_player" ON "player_batting_games" USING btree ("player_id","game_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batting_season_stint" ON "player_batting_seasons" USING btree ("player_id","season_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pitching_game_player" ON "player_pitching_games" USING btree ("player_id","game_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pitching_season_stint" ON "player_pitching_seasons" USING btree ("player_id","season_id","team_id");--> statement-breakpoint
CREATE INDEX "membership_player" ON "player_team_memberships" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_stint" ON "player_team_memberships" USING btree ("player_id","team_id","season_id","starts_on");--> statement-breakpoint
CREATE UNIQUE INDEX "score_observation" ON "prospect_score_history" USING btree ("player_id","model_version","observed_at");--> statement-breakpoint
CREATE INDEX "score_history_timeline" ON "prospect_score_history" USING btree ("player_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_observation" ON "rankings" USING btree ("player_id","source","scope","category","as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "season_year_name" ON "seasons" USING btree ("year","name");