import Link from "next/link";
import { PageHeading } from "@/components/ui/primitives";
export default function NotFound() {
  return (
    <>
      <PageHeading
        title="Outside the field"
        eyebrow="404 / NOT FOUND"
        description="This page or demo profile could not be found."
      />
      <Link href="/players" className="primary-link">
        Explore demo players ↗
      </Link>
    </>
  );
}
