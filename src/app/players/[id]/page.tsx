import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { prospectRepository } from "@/services/prospects";
import { PageHeading, SectionTitle } from "@/components/ui/primitives";
import { Spotlight } from "@/components/market/spotlight";
import { NewsList } from "@/components/market/news-list";
export async function generateStaticParams() {
  return (await prospectRepository.listPlayers()).map((p) => ({ id: p.id }));
}
export default async function PlayerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const player = await prospectRepository.findPlayer(id);
  if (!player) notFound();
  const team = await prospectRepository.findTeam(player.teamId);
  if (!team) notFound();
  const news = (await prospectRepository.listNews()).filter((n) =>
    n.playerIds.includes(id),
  );
  return (
    <>
      <Link href="/players" className="back-link">
        <ArrowLeft size={14} /> All prospects
      </Link>
      <PageHeading
        title={player.name}
        eyebrow="FICTIONAL PLAYER PROFILE"
        description={`${player.position} · ${player.year} · Bats ${player.bats} / Throws ${player.throws} · 2026 demo season`}
      />
      <div className="profile-grid">
        <section className="panel">
          <Spotlight player={player} team={team} />
        </section>
        <section className="panel profile-details">
          <SectionTitle title="Player dossier" />
          <dl>
            <dt>Team</dt>
            <dd>
              <Link href={`/teams/${team.id}`}>{team.name} ↗</Link>
            </dd>
            <dt>Level</dt>
            <dd>{team.level}</dd>
            <dt>Conference</dt>
            <dd>{team.conference}</dd>
            <dt>Data source</dt>
            <dd>Fictional development dataset</dd>
            <dt>Analytics status</dt>
            <dd>Illustrative values; no scoring model</dd>
          </dl>
          <p className="muted">
            Real scouting reports, game logs, and highlights will arrive in
            future phases.
          </p>
        </section>
      </div>
      <section className="news-section">
        <SectionTitle title="Related demo stories" />
        {news.length ? (
          <NewsList items={news} />
        ) : (
          <div className="empty-state">
            No demo stories linked to this player yet.
          </div>
        )}
      </section>
    </>
  );
}
