ALTER TABLE "games" ADD COLUMN "official_date" date;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "league_id" uuid;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "home_score" integer;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "away_score" integer;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "venue" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "boxscore_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "player_batting_games" ADD COLUMN "runs" integer;--> statement-breakpoint
ALTER TABLE "player_batting_games" ADD COLUMN "rbi" integer;--> statement-breakpoint
ALTER TABLE "player_batting_games" ADD COLUMN "caught_stealing" integer;--> statement-breakpoint
ALTER TABLE "player_batting_games" ADD COLUMN "sacrifice_bunts" integer;--> statement-breakpoint
ALTER TABLE "player_batting_games" ADD COLUMN "catcher_interference" integer;--> statement-breakpoint
ALTER TABLE "player_batting_seasons" ADD COLUMN "runs" integer;--> statement-breakpoint
ALTER TABLE "player_batting_seasons" ADD COLUMN "rbi" integer;--> statement-breakpoint
ALTER TABLE "player_batting_seasons" ADD COLUMN "caught_stealing" integer;--> statement-breakpoint
ALTER TABLE "player_batting_seasons" ADD COLUMN "sacrifice_bunts" integer;--> statement-breakpoint
ALTER TABLE "player_batting_seasons" ADD COLUMN "catcher_interference" integer;--> statement-breakpoint
ALTER TABLE "player_pitching_games" ADD COLUMN "runs" integer;--> statement-breakpoint
ALTER TABLE "player_pitching_games" ADD COLUMN "hit_batters" integer;--> statement-breakpoint
ALTER TABLE "player_pitching_games" ADD COLUMN "pitches" integer;--> statement-breakpoint
ALTER TABLE "player_pitching_seasons" ADD COLUMN "runs" integer;--> statement-breakpoint
ALTER TABLE "player_pitching_seasons" ADD COLUMN "hit_batters" integer;--> statement-breakpoint
ALTER TABLE "player_pitching_seasons" ADD COLUMN "pitches" integer;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "height" text;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "weight" integer;--> statement-breakpoint
ALTER TABLE "source_roster_observations" ADD COLUMN "season_id" uuid;--> statement-breakpoint
ALTER TABLE "source_roster_observations" ADD COLUMN "roster_status" text;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_roster_observations" ADD CONSTRAINT "source_roster_observations_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;