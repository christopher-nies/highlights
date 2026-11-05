// Templater user script: today's highlight from the self-hosted highlights service.
// Copy into your Templater user-scripts folder and call it from the daily template with the service's address:
//   <% await tp.user.daily_highlight(tp, "http://your-host:8790") %>
// The address lives in your template, not here, so this file carries nothing about your network.
// When the service is unreachable (e.g. away from home) it returns "" so the note is still created, untouched.

const TIMEOUT_MS = 4000;

function quoteLines(text) {
	return text.split(/\r?\n/).map((l) => `> ${l}`.trimEnd()).join("\n");
}

function render(h) {
	const out = ["> [!quote] From your highlights", quoteLines(h.text.trim())];
	if (h.note) out.push(">", `> 💭 ${h.note.trim().replace(/\r?\n/g, " ")}`);
	const title = (h.title || "Source").replace(/[[\]]/g, "");
	const link = h.deep_link || h.url;
	const source = link ? `[${title}](${link})` : title;
	out.push(">", `> — ${h.author ? `${h.author}, ` : ""}${source}`);
	return out.join("\n");
}

module.exports = async (tp, base) => {
	if (!base) return "";
	const ENDPOINT = `${String(base).replace(/\/+$/, "")}/today`;
	const title = tp?.file?.title || "";
	const date = /^\d{4}-\d{2}-\d{2}$/.test(title) ? title : "";
	const url = date ? `${ENDPOINT}?date=${date}` : ENDPOINT;
	try {
		const res = await Promise.race([
			tp.obsidian.requestUrl({ url, throw: false }),
			new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
		]);
		if (!res || res.status !== 200) return "";
		const h = typeof res.json === "object" ? res.json : JSON.parse(res.text);
		return h && h.text ? render(h) : "";
	} catch (e) {
		console.log("daily_highlight: service not reachable", e);
		return "";
	}
};

module.exports.render = render;
