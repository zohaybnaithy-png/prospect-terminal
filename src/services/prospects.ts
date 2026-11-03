/** Fictional demo fixture access for tests and the dev seed only; not used by user-facing routes. */
import {
  news,
  players,
  teams,
  organizations,
  contexts,
  memberships,
  organizationMemberships,
} from "@/data/demo";
import type {
  NewsItem,
  Player,
  Team,
  Organization,
  DevelopmentContext,
  Catalog,
} from "@/types/baseball";
/** Explicit demo read-model boundary. DATABASE_URL never silently switches data sources. */
export interface ProspectRepository {
  listPlayers(): Promise<Player[]>;
  findPlayer(id: string): Promise<Player | undefined>;
  listTeams(): Promise<Team[]>;
  findTeam(id: string): Promise<Team | undefined>;
  listOrganizations(): Promise<Organization[]>;
  findOrganization(id: string): Promise<Organization | undefined>;
  listContexts(): Promise<DevelopmentContext[]>;
  findContext(slug: string): Promise<DevelopmentContext | undefined>;
  listNews(): Promise<NewsItem[]>;
  catalog(): Promise<Catalog>;
}
export const prospectRepository: ProspectRepository = {
  async listPlayers() {
    return [...players];
  },
  async findPlayer(id) {
    return players.find((p) => p.id === id);
  },
  async listTeams() {
    return [...teams];
  },
  async findTeam(id) {
    return teams.find((t) => t.id === id);
  },
  async listOrganizations() {
    return [...organizations];
  },
  async findOrganization(id) {
    return organizations.find((o) => o.id === id);
  },
  async listContexts() {
    return [...contexts];
  },
  async findContext(slug) {
    return contexts.find((c) => c.slug === slug);
  },
  async listNews() {
    return [...news].sort((a, b) => b.date.localeCompare(a.date));
  },
  async catalog() {
    return {
      players,
      teams,
      organizations,
      contexts,
      memberships,
      organizationMemberships,
      news: await this.listNews(),
    };
  },
};
// Legacy /market remains a route alias; current discovery is implemented in discovery.ts.
export async function getMarketOverview() {
  const all = await prospectRepository.listPlayers();
  return {
    top: [...all].sort((a, b) => b.grade - a.grade),
    rising: all
      .filter((p) => p.momentum > 0)
      .sort((a, b) => b.momentum - a.momentum),
    falling: all
      .filter((p) => p.momentum < 0)
      .sort((a, b) => a.momentum - b.momentum),
  };
}
