import type { Metadata } from "next";
import { PageHeading } from "@/components/ui/primitives";
import { NewsList } from "@/components/market/news-list";
import { prospectRepository } from "@/services/prospects";
export const metadata: Metadata = { title: "News" };
export default async function NewsPage() {
  const catalog = await prospectRepository.catalog();
  return (
    <>
      <PageHeading
        title="Prospect news"
        description="Performances, promotions, and development stories across the minors. Chronological fictional stories, including players beyond the performance leaders."
      />
      <NewsList items={catalog.news} catalog={catalog} />
    </>
  );
}
