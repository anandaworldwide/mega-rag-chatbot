import {
  GENERIC_REDIRECT_RESPONSES,
  GENERIC_REDIRECT_SIMILARITY_LIMIT,
  hasLahiriScopedNegation,
  isGenericRedirectOnly,
  passesIndiaLocationGuard,
  passesItalyLocationGuard,
  passesLocationRedirectGuard,
  passesLondonLocationGuard,
  passesPortlandLocationGuard,
} from "./semanticAnswerGuards";

describe("semanticAnswerGuards", () => {
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
