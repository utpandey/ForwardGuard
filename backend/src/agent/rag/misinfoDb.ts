/**
 * rag/misinfoDb.ts — Seed database of well-known misinformation and hoaxes.
 *
 * Each entry contains the misinformation claim, keywords for retrieval,
 * the true verdict, a debunking summary, and a reference URL.
 *
 * This serves as the "document store" for our RAG pipeline. When a user
 * submits a claim, we search this database for matches before hitting
 * external APIs — giving instant results for known hoaxes.
 */

export interface MisinfoEntry {
  id: string;
  claim: string;
  keywords: string[];
  verdict: "FALSE" | "MISLEADING" | "SCAM";
  debunking: string;
  source: string;
}

/**
 * Curated database of ~20 well-known misinformation claims.
 * Each entry is designed for keyword-overlap retrieval.
 */
export const MISINFO_DATABASE: MisinfoEntry[] = [
  {
    id: "m1",
    claim: "NASA confirmed 15 days of darkness in November",
    keywords: ["nasa", "15 days", "darkness", "november", "dark", "planet", "alignment"],
    verdict: "FALSE",
    debunking:
      "This is a recurring hoax since 2015. NASA has never made such a claim. Planetary alignments cannot block sunlight for extended periods.",
    source: "https://www.snopes.com/fact-check/15-days-of-darkness/",
  },
  {
    id: "m2",
    claim: "5G towers cause COVID-19",
    keywords: ["5g", "covid", "coronavirus", "towers", "radiation", "pandemic", "cause"],
    verdict: "FALSE",
    debunking:
      "COVID-19 is caused by the SARS-CoV-2 virus. 5G is non-ionizing radio frequency radiation and cannot create or spread viruses. The WHO has confirmed no link.",
    source: "https://www.who.int/emergencies/diseases/novel-coronavirus-2019/advice-for-public/myth-busters",
  },
  {
    id: "m3",
    claim: "The Earth is flat",
    keywords: ["flat earth", "globe", "nasa lies", "flat", "earth", "horizon", "curvature"],
    verdict: "FALSE",
    debunking:
      "The Earth is an oblate spheroid. This has been confirmed by satellite imagery, physics, astronomy, and direct observation for centuries.",
    source: "https://www.snopes.com/news/2016/01/26/flat-earth-movement/",
  },
  {
    id: "m4",
    claim: "Vaccines cause autism",
    keywords: ["vaccine", "autism", "mmr", "vaccination", "mercury", "thimerosal", "children"],
    verdict: "FALSE",
    debunking:
      "The original 1998 Wakefield study was retracted for fraud. Multiple large-scale studies involving millions of children have found no link between vaccines and autism.",
    source: "https://www.who.int/news-room/questions-and-answers/item/vaccines-and-immunization-what-is-vaccination",
  },
  {
    id: "m5",
    claim: "Drinking bleach cures COVID-19",
    keywords: ["bleach", "cure", "covid", "disinfectant", "drink", "mms", "chlorine dioxide"],
    verdict: "FALSE",
    debunking:
      "Ingesting bleach or disinfectant is extremely dangerous and can be fatal. No disinfectant product is safe for human consumption. The FDA has issued warnings.",
    source: "https://www.fda.gov/consumers/consumer-updates/danger-dont-drink-miracle-mineral-solution-or-similar-products",
  },
  {
    id: "m6",
    claim: "Bill Gates wants to implant microchips through vaccines",
    keywords: ["bill gates", "microchip", "vaccine", "implant", "tracking", "chip", "gates foundation"],
    verdict: "FALSE",
    debunking:
      "This conspiracy theory misrepresents a Gates Foundation-funded study on invisible ink tattoos for vaccine records. No vaccine contains a microchip.",
    source: "https://www.reuters.com/article/uk-factcheck-vaccine-microchip-gates-idUSKBN28V2GQ",
  },
  {
    id: "m7",
    claim: "The moon landing was faked by NASA",
    keywords: ["moon landing", "fake", "hoax", "nasa", "apollo", "studio", "flag waving"],
    verdict: "FALSE",
    debunking:
      "Six Apollo missions landed on the Moon between 1969-1972. Physical evidence includes retroreflectors still used today, moon rocks, and independent verification by other nations.",
    source: "https://www.nasa.gov/mission_pages/apollo/missions/index.html",
  },
  {
    id: "m8",
    claim: "WhatsApp will start charging a monthly fee",
    keywords: ["whatsapp", "charging", "fee", "monthly", "subscription", "paid", "free"],
    verdict: "FALSE",
    debunking:
      "WhatsApp has been free since 2016 when it dropped its $1/year fee. Meta (Facebook) has repeatedly confirmed WhatsApp will remain free for personal use.",
    source: "https://www.snopes.com/fact-check/whatsapp-start-charging/",
  },
  {
    id: "m9",
    claim: "Forwarding this message to 10 people will give you free data",
    keywords: ["forward", "free data", "10 people", "share", "free internet", "recharge", "airtel", "jio"],
    verdict: "SCAM",
    debunking:
      "This is a classic chain-letter scam. No telecom company offers free data for forwarding messages. These chains are used to spread malware or harvest data.",
    source: "https://www.snopes.com/fact-check/category/chain-messages/",
  },
  {
    id: "m10",
    claim: "Eating bananas with brown spots prevents cancer",
    keywords: ["banana", "brown spots", "cancer", "prevent", "cure", "tnf", "tumor"],
    verdict: "MISLEADING",
    debunking:
      "While ripe bananas contain some beneficial compounds, no single food can prevent or cure cancer. The viral claim vastly overstates a preliminary Japanese study.",
    source: "https://www.snopes.com/fact-check/banana-cancer-cure/",
  },
  {
    id: "m11",
    claim: "China created COVID-19 in a lab as a bioweapon",
    keywords: ["china", "lab", "bioweapon", "wuhan", "created", "covid", "engineered", "leak"],
    verdict: "FALSE",
    debunking:
      "While the origin of COVID-19 is still debated (natural spillover vs. lab leak), there is no evidence it was engineered as a bioweapon. Multiple intelligence agencies have found no evidence of bioweapon development.",
    source: "https://www.factcheck.org/2021/07/scicheck-origins-of-sars-cov-2/",
  },
  {
    id: "m12",
    claim: "Drinking hot water kills the coronavirus",
    keywords: ["hot water", "kill", "coronavirus", "covid", "warm", "gargle", "temperature"],
    verdict: "FALSE",
    debunking:
      "Drinking hot water does not kill viruses inside the body. The virus replicates in cells at body temperature (37C). The WHO has debunked this claim.",
    source: "https://www.who.int/emergencies/diseases/novel-coronavirus-2019/advice-for-public/myth-busters",
  },
  {
    id: "m13",
    claim: "Facebook is going to charge users starting next month",
    keywords: ["facebook", "charge", "users", "fee", "paid", "subscription", "free"],
    verdict: "FALSE",
    debunking:
      "Facebook/Meta has been free since its inception and makes money from advertising. This hoax has circulated for over a decade in various forms.",
    source: "https://www.snopes.com/fact-check/facebook-start-charging/",
  },
  {
    id: "m14",
    claim: "Holding your breath for 10 seconds tests for COVID-19",
    keywords: ["hold breath", "10 seconds", "test", "covid", "lungs", "fibrosis", "self-test"],
    verdict: "FALSE",
    debunking:
      "This is not a valid COVID-19 test. Only PCR and antigen tests can detect the virus. Many infected people can hold their breath normally.",
    source: "https://www.who.int/emergencies/diseases/novel-coronavirus-2019/advice-for-public/myth-busters",
  },
  {
    id: "m15",
    claim: "The government is adding tracking devices to new currency notes",
    keywords: ["government", "tracking", "currency", "notes", "rfid", "chip", "money", "bills"],
    verdict: "FALSE",
    debunking:
      "Currency notes do not contain tracking chips. While some notes have security features like metallic strips, these are anti-counterfeiting measures, not tracking devices.",
    source: "https://www.snopes.com/fact-check/rfid-chips-in-new-100-bills/",
  },
  {
    id: "m16",
    claim: "Sleeping near your phone causes brain cancer",
    keywords: ["phone", "cancer", "brain", "radiation", "sleep", "mobile", "tumor", "cell phone"],
    verdict: "MISLEADING",
    debunking:
      "Major studies (including the WHO's INTERPHONE study) have found no conclusive evidence that mobile phones cause brain cancer. Phone radiation is non-ionizing.",
    source: "https://www.who.int/news-room/fact-sheets/detail/electromagnetic-fields-and-public-health-mobile-phones",
  },
  {
    id: "m17",
    claim: "Lemon juice and baking soda cure cancer",
    keywords: ["lemon", "baking soda", "cancer", "cure", "alkaline", "ph", "treatment"],
    verdict: "FALSE",
    debunking:
      "No food or home remedy can cure cancer. The body maintains its pH balance regardless of diet. Cancer treatment requires medical intervention. This claim is dangerous.",
    source: "https://www.cancerresearchuk.org/about-cancer/causes-of-cancer/cancer-myths/can-baking-soda-cure-cancer",
  },
  {
    id: "m18",
    claim: "Mark Zuckerberg is giving away money to Facebook users who share this post",
    keywords: ["zuckerberg", "giving away", "money", "share", "facebook", "giveaway", "million"],
    verdict: "SCAM",
    debunking:
      "This is a recurring social media scam. Mark Zuckerberg is not giving away money to random users. These posts are used for engagement farming or phishing.",
    source: "https://www.snopes.com/fact-check/mark-zuckerberg-giving-away-money/",
  },
  {
    id: "m19",
    claim: "Onions placed in rooms absorb viruses and prevent flu",
    keywords: ["onion", "room", "absorb", "virus", "flu", "bacteria", "prevent", "sickness"],
    verdict: "FALSE",
    debunking:
      "Onions do not absorb viruses or bacteria from the air. This is a medieval folk remedy with no scientific basis. Proper hygiene and vaccination prevent flu.",
    source: "https://www.snopes.com/fact-check/onion-flu-absorb/",
  },
  {
    id: "m20",
    claim: "The Indian government is giving free laptops to all students via WhatsApp registration",
    keywords: ["government", "free laptop", "students", "whatsapp", "registration", "scheme", "india"],
    verdict: "SCAM",
    debunking:
      "This is a phishing scam. Government schemes are announced through official channels, not WhatsApp. The registration links collect personal data for fraud.",
    source: "https://factly.in/no-the-central-government-is-not-distributing-free-laptops/",
  },
];
