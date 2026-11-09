// "Sort in topics": asks Gemini to group the missed questions into topics. The model only returns question
// NUMBERS grouped under topic names; the texts are put back by the bot, so nothing is invented or altered.
export async function sortInTopics(env, questions) {
  if (!env.GEMINI_API_KEY) throw new Error("no key");
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const list = questions.map((q, i) => `${i + 1}. ${q.text}`).join("\n");
  const prompt =
    "Group these quiz questions into a few short topics (2-4 words each, same language as the questions). " +
    "Every question number must appear in exactly one topic. Reply with JSON only: " +
    '[{"topic":"Topic name","items":[1,2]}]\n\n' + list;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  const groups = JSON.parse(text.replace(/^```json|```$/g, "").trim());
  const seen = new Set(), out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    const items = (g.items || []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= questions.length && !seen.has(n));
    items.forEach((n) => seen.add(n));
    if (items.length && g.topic) out.push({ topic: String(g.topic).slice(0, 60), items: items.map((n) => n - 1) });
  }
  const rest = questions.map((_, i) => i).filter((i) => !seen.has(i + 1));
  if (rest.length) out.push({ topic: "Other", items: rest });
  return out;
}
