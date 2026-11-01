import type { Metadata } from "next";
import Image from "next/image";
import { demoHighlights } from "@/data/demo-home";
import { prospectRepository } from "@/services/prospects";
import { PageHeading } from "@/components/ui/primitives";
import { PlayerLink, TeamLink } from "@/components/ui/entity-links";
export const metadata: Metadata = { title: "Highlight previews" };
export default async function HighlightsPage() {
  const catalog = await prospectRepository.catalog();
  return (
    <>
      <PageHeading
        title="Highlight previews"
        description="Fictional baseball storyboards, illustrated for this development preview. No playable footage is available. Licensed video and media sources can be connected in a later phase."
      />
      <div className="highlight-preview-list">
        {demoHighlights.map((item) => {
          const player = catalog.players.find((p) => p.id === item.playerId)!;
          return (
            <article key={item.id} id={item.id}>
              <Image src={item.image} alt={item.alt} width={900} height={420} />
              <div>
                <p className="eyebrow">Demo artwork · {item.date}</p>
                <h2>{item.title}</h2>
                <p>{item.description}</p>
                <div className="entity-links">
                  <PlayerLink player={player} />
                  <TeamLink
                    team={catalog.teams.find((t) => t.id === player.teamId)!}
                    full
                  />
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
