import { news, players, teams } from "@/data/demo";
import type { NewsItem, Player, Team } from "@/types/baseball";

/** Read-model boundary: swap implementations after real ingestion is validated.
 * Demo mode is explicit even when DATABASE_URL is present; DB errors are never
 * silently disguised as real data. No credentials are required to render. */
export interface ProspectRepository {
  listPlayers(): Promise<Player[]>;
  findPlayer(id: string): Promise<Player | undefined>;
  listTeams(): Promise<Team[]>;
  findTeam(id: string): Promise<Team | undefined>;
  listNews(): Promise<NewsItem[]>;
}
export const prospectRepository: ProspectRepository = {
  async listPlayers() {
    return [...players];
  },
  async findPlayer(id) {
    return players.find((player) => player.id === id);
  },
  async listTeams() {
    return [...teams];
  },
  async findTeam(id) {
    return teams.find((team) => team.id === id);
  },
  async listNews() {
    return [...news];
  },
};
export async function getMarketOverview() {
  const all = await prospectRepository.listPlayers();
  return {
    top: [...all].sort((a, b) => b.grade - a.grade),
    rising: [...all]
      .filter((p) => p.momentum > 0)
      .sort((a, b) => b.momentum - a.momentum),
    falling: [...all]
      .filter((p) => p.momentum < 0)
      .sort((a, b) => a.momentum - b.momentum),
  };
}
