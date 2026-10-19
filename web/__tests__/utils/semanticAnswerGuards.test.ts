import {
  GENERIC_REDIRECT_RESPONSES,
  GENERIC_REDIRECT_SIMILARITY_LIMIT,
  hasLahiriScopedNegation,
  hasNamedGroupOrCenter,
  isGenericRedirectOnly,
  passesRedirectSimilarityGuard,
  passesIndiaLocationGuard,
  passesItalyLocationGuard,
  passesLocationRedirectGuard,
  passesLondonLocationGuard,
  passesPortlandLocationGuard,
  queryNamesNoPlace,
  setAcceptLocationSearchMiss,
} from "./semanticAnswerGuards";

describe("semanticAnswerGuards", () => {
  afterEach(() => {
    setAcceptLocationSearchMiss(false);
  });

  it("keeps the generic redirect set and its own similarity limit", () => {
    expect(GENERIC_REDIRECT_RESPONSES.length).toBeGreaterThanOrEqual(3);
    expect(GENERIC_REDIRECT_RESPONSES.join(" ")).toMatch(/Find Ananda Near You/i);
    expect(GENERIC_REDIRECT_RESPONSES.join(" ")).toMatch(/locations worldwide/i);
    expect(GENERIC_REDIRECT_SIMILARITY_LIMIT).toBe(0.81);
  });

  it("fails a generic redirect-only answer for location, London, Portland, India, and Italy", () => {
    const genericRedirect =
      "Ananda has locations worldwide. To find information, please visit our Find Ananda Near You page.";
    expect(isGenericRedirectOnly(genericRedirect)).toBe(true);
    expect(passesLocationRedirectGuard(genericRedirect)).toBe(false);
    expect(passesLondonLocationGuard(genericRedirect)).toBe(false);
    expect(passesPortlandLocationGuard(genericRedirect)).toBe(false);
    expect(passesIndiaLocationGuard(genericRedirect)).toBe(false);
    expect(passesItalyLocationGuard(genericRedirect)).toBe(false);
  });

  it("treats a Paris echo plus visit-our-website as redirect-only", () => {
    const query = "Paris";
    const answer = "To find centers near Paris, visit our website.";
    expect(isGenericRedirectOnly(answer, query)).toBe(true);
    expect(passesLocationRedirectGuard(answer, query)).toBe(false);
  });

  it("does not treat Ananda is present worldwide as a named center", () => {
    const answer = "Ananda is present worldwide. Please visit our website.";
    expect(isGenericRedirectOnly(answer)).toBe(true);
    expect(passesLocationRedirectGuard(answer)).toBe(false);
  });

  it("does not treat Ananda in your area as a named center", () => {
    const answer = "Ananda in your area ... visit our website.";
    expect(isGenericRedirectOnly(answer)).toBe(true);
    expect(passesLocationRedirectGuard(answer)).toBe(false);
    expect(passesRedirectSimilarityGuard(answer, "", 0.82)).toBe(false);
  });

  it("keeps the 0.81 embedding backstop for a location-search miss", () => {
    const query = "Find a center near me";
    const answer = "Searching locations... Unable to determine your location. Visit Find Ananda Near You.";
    setAcceptLocationSearchMiss(true);
    expect(isGenericRedirectOnly(answer, query)).toBe(false);
    expect(passesRedirectSimilarityGuard(answer, query, 0.82)).toBe(false);
  });

  it("skips the 0.81 embedding limit for an address, phone, named center, or regional domain", () => {
    expect(passesRedirectSimilarityGuard("Ananda Portland, 123 Main Street.", "Portland", 0.82)).toBe(true);
    expect(passesRedirectSimilarityGuard("Ananda Berkeley. Phone: (510) 555-0100.", "Berkeley", 0.82)).toBe(true);
    expect(passesRedirectSimilarityGuard("Ananda Meditation Group of Paris.", "Paris", 0.82)).toBe(true);
    expect(passesRedirectSimilarityGuard("See anandaindia.org for local groups.", "India", 0.82)).toBe(true);
  });

  it("passes a Find Ananda answer that also gives a street address", () => {
    const query = "Portland, Oregon";
    const answer = "Ananda Portland, 123 Main Street. Visit Find Ananda Near You.";
    expect(isGenericRedirectOnly(answer, query)).toBe(false);
    expect(passesPortlandLocationGuard(answer, query)).toBe(true);
  });

  it("passes a Find Ananda answer that also gives a phone number", () => {
    const query = "What Ananda centers are near Berkeley, California?";
    const answer = "Ananda Berkeley. Phone: (510) 555-0100. Visit Find Ananda Near You.";
    expect(isGenericRedirectOnly(answer, query)).toBe(false);
    expect(passesLocationRedirectGuard(answer, query)).toBe(true);
  });

  it("passes a named group that is more than the echoed city", () => {
    const query = "Paris";
    const answer = "Ananda Meditation Group of Paris. Visit Find Ananda Near You.";
    expect(isGenericRedirectOnly(answer, query)).toBe(false);
    expect(passesLocationRedirectGuard(answer, query)).toBe(true);
  });

  it("does not treat Ananda offers a meditation group as a named group", () => {
    expect(hasNamedGroupOrCenter("Ananda offers a meditation group")).toBe(false);
    expect(isGenericRedirectOnly("Ananda offers a meditation group. Visit Find Ananda Near You.")).toBe(true);
  });

  it("does not treat Ananda near you has a center as a named group", () => {
    expect(hasNamedGroupOrCenter("Ananda near you has a center")).toBe(false);
    expect(isGenericRedirectOnly("Ananda near you has a center. Visit Find Ananda Near You.")).toBe(true);
  });

  it("fails a miss plus Find Ananda when geo-miss acceptance is off", () => {
    const query = "Paris";
    const answer = "Couldn't find Ananda centers near Paris. Visit Find Ananda Near You.";
    setAcceptLocationSearchMiss(false);
    expect(isGenericRedirectOnly(answer, query)).toBe(true);
    expect(passesLocationRedirectGuard(answer, query)).toBe(false);
  });

  it("passes a miss plus Find Ananda when geo-miss acceptance is on", () => {
    const query = "Paris";
    const answer = "Couldn't find Ananda centers near Paris. Visit Find Ananda Near You.";
    setAcceptLocationSearchMiss(true);
    expect(isGenericRedirectOnly(answer, query)).toBe(false);
    expect(passesLocationRedirectGuard(answer, query)).toBe(true);
    expect(passesLondonLocationGuard(answer, query)).toBe(false);
    expect(passesIndiaLocationGuard("No Ananda centers listed in India. Visit Find Ananda Near You.")).toBe(false);
    expect(passesItalyLocationGuard("No Ananda centers found close to Italy. Visit Find Ananda Near You.")).toBe(false);
  });

  it("passes a Find Ananda redirect without miss phrasing when geo-miss acceptance is on", () => {
    const query = "Paris";
    const answer = "Please visit our Find Ananda Near You page.";
    setAcceptLocationSearchMiss(true);
    expect(isGenericRedirectOnly(answer, query)).toBe(false);
    expect(passesLocationRedirectGuard(answer, query)).toBe(true);
    expect(passesRedirectSimilarityGuard(answer, query, 0.82)).toBe(false);
    expect(passesLondonLocationGuard(answer, query)).toBe(false);
  });

  it("fails a London answer that only says centers in London and visit Find Ananda", () => {
    const londonRedirect = "There are Ananda centers in London, visit Find Ananda Near You.";
    expect(passesLondonLocationGuard(londonRedirect)).toBe(false);
  });

  it("fails an India answer that only names the country", () => {
    expect(passesIndiaLocationGuard("Yes, there are Ananda centers in India.")).toBe(false);
  });

  it("fails an Italy answer that only names the country", () => {
    expect(passesItalyLocationGuard("Yes, there are Ananda centers in Italy.")).toBe(false);
  });

  it("fails London phrasing that only says center in London or United Kingdom", () => {
    expect(passesLondonLocationGuard("There is a center in London, UK.")).toBe(false);
    expect(passesLondonLocationGuard("Ananda has a center in the United Kingdom.")).toBe(false);
  });

  it("fails a Lahiri mention with no scoped negation nearby", () => {
    expect(hasLahiriScopedNegation("Broader teachings discuss Lahiri Mahasaya's view even if this source does not.")).toBe(
      false
    );
    expect(hasLahiriScopedNegation("Related spiritual texts say Lahiri Mahasaya taught about destiny in other places.")).toBe(
      false
    );
  });

  it("passes a location answer that names a center and may also mention Find Ananda", () => {
    const good =
      "Here are Ananda centers near you: Ananda Portland at a local address. You can also visit Find Ananda Near You.";
    expect(isGenericRedirectOnly(good)).toBe(false);
    expect(passesLocationRedirectGuard(good)).toBe(true);
    expect(passesPortlandLocationGuard(good)).toBe(true);
  });

  it("passes a near-me answer that names a real center and includes the Find Ananda link", () => {
    const query = "Where is Ananda near me?";
    const good =
      "Here are Ananda centers near you: Ananda Palo Alto. You can also visit Find Ananda Near You at https://www.ananda.org/find-ananda/";
    expect(isGenericRedirectOnly(good, query)).toBe(false);
    expect(passesLocationRedirectGuard(good, query)).toBe(true);
  });

  it("passes a Portland answer that names a real center and includes the Find Ananda link", () => {
    const query = "Are there any Ananda centers in Portland, Oregon?";
    const good =
      "Here are Ananda centers near Portland: Ananda Portland at a local address. See also https://www.ananda.org/find-ananda/";
    expect(isGenericRedirectOnly(good, query)).toBe(false);
    expect(passesLocationRedirectGuard(good, query)).toBe(true);
    expect(passesPortlandLocationGuard(good, query)).toBe(true);
  });

  it("passes London answers with anandauk.org, Devizes, or a named London group", () => {
    expect(passesLondonLocationGuard("The nearest center is listed at anandauk.org.")).toBe(true);
    expect(passesLondonLocationGuard("Ananda United Kingdom in Devizes, Wiltshire has contact details.")).toBe(true);
    expect(passesLondonLocationGuard("There is a London meditation group that meets weekly.")).toBe(true);
  });

  it("passes India and Italy answers that name one listed center or a center domain", () => {
    expect(passesIndiaLocationGuard("Yes. Ananda has a center in Delhi.")).toBe(true);
    expect(passesIndiaLocationGuard("See anandaindia.org for local groups.")).toBe(true);
    expect(passesItalyLocationGuard("Ananda Europa is in Assisi.")).toBe(true);
    expect(passesItalyLocationGuard("The community is near Nocera Umbra.")).toBe(true);
  });

  it("detects no place in the query with a general city, region, country, or postal check", () => {
    expect(queryNamesNoPlace("Where is Ananda near me?")).toBe(true);
    expect(queryNamesNoPlace("Find a center near me")).toBe(true);
    expect(queryNamesNoPlace("Find a center")).toBe(true);
    expect(queryNamesNoPlace("Paris")).toBe(false);
    expect(queryNamesNoPlace("Ananda centers in Italy")).toBe(false);
    expect(queryNamesNoPlace("94002")).toBe(false);
    expect(queryNamesNoPlace("in London")).toBe(false);
    expect(queryNamesNoPlace("Portland, Oregon")).toBe(false);
  });

  it("accepts a no-place answer that asks for the location or says it does not know, only when the no-geo flag is on", () => {
    const query = "Where is Ananda near me?";
    const asks = "Please specify a city or location to find nearby Ananda centers.";
    const unknown = "Unable to determine your location.";
    const both =
      "Unable to determine your location. Please specify a city or location to find nearby Ananda centers.";
    setAcceptLocationSearchMiss(true);
    expect(isGenericRedirectOnly(asks, query)).toBe(false);
    expect(isGenericRedirectOnly(unknown, query)).toBe(false);
    expect(isGenericRedirectOnly(both, query)).toBe(false);
    expect(passesLocationRedirectGuard(both, query)).toBe(true);
  });

  it("requires a named center for a no-place answer when geo data is present", () => {
    const query = "Find a center near me";
    const asks = "Please specify a city or location to find nearby Ananda centers.";
    const unknown = "Unable to determine your location.";
    const findAnanda = "Please visit our Find Ananda Near You page.";
    const named = "Here are Ananda centers near you: Ananda Palo Alto.";
    setAcceptLocationSearchMiss(false);
    expect(isGenericRedirectOnly(asks, query)).toBe(true);
    expect(isGenericRedirectOnly(unknown, query)).toBe(true);
    expect(isGenericRedirectOnly(findAnanda, query)).toBe(true);
    expect(passesLocationRedirectGuard(asks, query)).toBe(false);
    expect(isGenericRedirectOnly(named, query)).toBe(false);
    expect(passesLocationRedirectGuard(named, query)).toBe(true);
  });

  it("fails Ananda is present worldwide for a near-me query even when the no-geo flag is on", () => {
    const query = "Where is Ananda near me?";
    const answer = "Ananda is present worldwide.";
    setAcceptLocationSearchMiss(true);
    expect(isGenericRedirectOnly(answer, query)).toBe(true);
    expect(passesLocationRedirectGuard(answer, query)).toBe(false);
  });

  it("fails Ananda in your area for a near-me query even when the no-geo flag is on", () => {
    const query = "Find a center near me";
    const answer = "Ananda in your area has groups you can visit.";
    setAcceptLocationSearchMiss(true);
    expect(isGenericRedirectOnly(answer, query)).toBe(true);
    expect(passesLocationRedirectGuard(answer, query)).toBe(false);
  });

  it("fails a plain Find Ananda answer for a no-place query even when the no-geo flag is on", () => {
    const query = "Where is Ananda near me?";
    const answer = "Please visit our Find Ananda Near You page.";
    setAcceptLocationSearchMiss(true);
    expect(isGenericRedirectOnly(answer, query)).toBe(true);
    expect(passesLocationRedirectGuard(answer, query)).toBe(false);
  });

  it("passes a Lahiri scoped miss when a negation is within about 120 characters either way", () => {
    expect(
      hasLahiriScopedNegation(
        "The Bible: New Testament: Book of Matthew: Chapter 5 does not contain direct teachings from Lahiri Mahasaya on this point."
      )
    ).toBe(true);
    expect(hasLahiriScopedNegation("Lahiri Mahasaya is not found in Matthew chapter 5.")).toBe(true);
    expect(hasLahiriScopedNegation("This chapter has no direct quotes or teachings from Lahiri Mahasaya.")).toBe(true);
    expect(hasLahiriScopedNegation("Matthew 5 does not attribute material to Lahiri Mahasaya.")).toBe(true);
    expect(
      hasLahiriScopedNegation(
        "This source does not contain that theme. " +
          "A long unrelated aside follows here so the later author name sits far from the negation phrase. " +
          "Still later the text names Lahiri Mahasaya without a nearby miss clause."
      )
    ).toBe(false);
  });
});
