// The fixtures are written by hand, so these tests pin them to the structure the
// live APIs actually returned when scripts/record-shapes.ts last ran.
import { describe, expect, test } from "bun:test";
import { conformance, type Shape } from "../scripts/shape.ts";
import { fixture } from "./helpers.ts";

const PAIRS = ["greenhouse-list", "greenhouse-job", "lever", "ashby", "remotive", "arbeitnow"];

describe("fixtures match the recorded API shapes", () => {
  test.each(PAIRS)("%s", (name) => {
    expect(conformance(fixture(name), fixture<Shape>(`shapes/${name}`))).toEqual([]);
  });

  test("a field the API never sent is reported", () => {
    const shape = fixture<Shape>("shapes/lever");
    const bad = [{ ...fixture<object[]>("lever")[0], postedDate: "2026-01-01" }];
    expect(conformance(bad, shape)).toEqual(["$[0].postedDate: not in the live response"]);
  });

  test("fields each parser reads are in the live shape", () => {
    const has = (name: string, path: string[]) => {
      let node: Shape | undefined = fixture<Shape>(`shapes/${name}`);
      for (const key of path) node = key === "[]" ? node?.items : node?.fields?.[key];
      return node !== undefined;
    };
    const reads: Record<string, string[][]> = {
      "greenhouse-list": [
        ["jobs", "[]", "id"],
        ["jobs", "[]", "title"],
        ["jobs", "[]", "absolute_url"],
        ["jobs", "[]", "location", "name"],
        ["jobs", "[]", "first_published"],
        ["jobs", "[]", "updated_at"],
        ["jobs", "[]", "company_name"],
      ],
      "greenhouse-job": [["content"]],
      lever: [
        ["[]", "text"],
        ["[]", "hostedUrl"],
        ["[]", "createdAt"],
        ["[]", "workplaceType"],
        ["[]", "categories", "location"],
        ["[]", "categories", "allLocations"],
        ["[]", "descriptionPlain"],
        ["[]", "lists", "[]", "text"],
        ["[]", "lists", "[]", "content"],
        ["[]", "additionalPlain"],
      ],
      ashby: [
        ["jobs", "[]", "title"],
        ["jobs", "[]", "location"],
        ["jobs", "[]", "secondaryLocations", "[]", "location"],
        ["jobs", "[]", "isRemote"],
        ["jobs", "[]", "workplaceType"],
        ["jobs", "[]", "publishedAt"],
        ["jobs", "[]", "isListed"],
        ["jobs", "[]", "jobUrl"],
        ["jobs", "[]", "descriptionPlain"],
      ],
      remotive: [
        ["jobs", "[]", "url"],
        ["jobs", "[]", "title"],
        ["jobs", "[]", "company_name"],
        ["jobs", "[]", "publication_date"],
        ["jobs", "[]", "candidate_required_location"],
        ["jobs", "[]", "description"],
      ],
      arbeitnow: [
        ["data", "[]", "url"],
        ["data", "[]", "company_name"],
        ["data", "[]", "title"],
        ["data", "[]", "description"],
        ["data", "[]", "remote"],
        ["data", "[]", "location"],
        ["data", "[]", "created_at"],
        ["links", "next"],
      ],
    };
    const missing = Object.entries(reads).flatMap(([name, paths]) =>
      paths.filter((p) => !has(name, p)).map((p) => `${name}: ${p.join(".")}`),
    );
    expect(missing).toEqual([]);
  });
});
