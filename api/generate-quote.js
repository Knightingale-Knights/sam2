import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const LOOKUP_TOOL = {
  name: "lookup_offices",
  description:
    "Look up office pricing data for one or more offices across one or more locations. Use this whenever the user asks for a quote, pricing, or information about specific offices.",
  input_schema: {
    type: "object",
    properties: {
      offices: {
        type: "array",
        description: "List of offices to look up",
        items: {
          type: "object",
          properties: {
            location: {
              type: "string",
              description:
                "The location name as the user referred to it (e.g. 'Wellington Street', 'Collins Street', 'Wellington', 'Collins'). Will be fuzzy-matched against known locations.",
            },
            office_number: {
              type: "integer",
              description: "The office number (e.g. 11, 10, 4).",
            },
          },
          required: ["location", "office_number"],
        },
      },
    },
    required: ["offices"],
  },
};

const SYSTEM_PROMPT = `You are a sales assistant for Knightingale's office space business. Your job is to parse natural-language requests from the sales team and identify which offices at which locations they want quoted.

When the user describes a quote request, call the lookup_offices tool with every office they mentioned. Do not respond with text — always use the tool.

Examples:
- "quote for office 5 and 10 in wellington street and office 20 in collins" → call tool with [{location: "Wellington Street", office_number: 5}, {location: "Wellington Street", office_number: 10}, {location: "Collins Street", office_number: 20}]
- "send me pricing on office 11 wellington" → call tool with [{location: "Wellington Street", office_number: 11}]`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { prompt } = req.body;
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Missing 'prompt' string in request body" });
  }

  try {
    const message = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [LOOKUP_TOOL],
      tool_choice: { type: "tool", name: "lookup_offices" },
      messages: [{ role: "user", content: prompt }],
    });

    const toolUse = message.content.find((block) => block.type === "tool_use");
    if (!toolUse) {
      return res.status(422).json({
        error: "Claude did not identify any offices in the prompt",
        raw: message.content,
      });
    }

    const requestedOffices = toolUse.input.offices;
    if (!requestedOffices?.length) {
      return res.status(422).json({ error: "No offices identified in the prompt" });
    }

    const results = [];
    const notFound = [];

    for (const item of requestedOffices) {
      const cleanedLocation = item.location.replace(/street/i, "").trim();

      const { data: locations, error: locErr } = await supabase
        .from("quote_locations")
        .select("id, name, slug")
        .ilike("name", `%${cleanedLocation}%`)
        .limit(1);

      if (locErr) throw locErr;
      if (!locations?.length) {
        notFound.push({ ...item, reason: "location not found" });
        continue;
      }

      const location = locations[0];

      const { data: offices, error: offErr } = await supabase
        .from("quote_offices")
        .select("*")
        .eq("location_id", location.id)
        .eq("office_number", item.office_number)
        .limit(1);

      if (offErr) throw offErr;
      if (!offices?.length) {
        notFound.push({ ...item, reason: "office not found at this location" });
        continue;
      }

      results.push({
        location: { name: location.name, slug: location.slug },
        office: offices[0],
      });
    }

    return res.status(200).json({
      parsed_request: requestedOffices,
      offices: results,
      not_found: notFound,
    });
  } catch (err) {
    console.error("generate-quote error:", err);
    return res.status(500).json({ error: err.message });
  }
}
