import { defineField, defineType } from "sanity";

const venue = () => defineField({ name: "venue", type: "reference", to: [{ type: "accessVenue" }], validation: r => r.required() });
const entity = () => defineField({ name: "entity", type: "reference", to: [{ type: "spatialEntity" }], validation: r => r.required() });
const source = () => defineField({ name: "source", type: "reference", to: [{ type: "accessSource" }], validation: r => r.required() });
const position = () => defineField({ name: "position", description: "[x, z] in metres", type: "array", of: [{ type: "number" }], validation: r => r.required().length(2) });
const obstacleFields = () => [
  defineField({ name: "id", type: "string" }),
  defineField({ name: "label", type: "string", validation: r => r.required().max(80) }),
  defineField({ name: "roomId", type: "string", validation: r => r.required() }), position(),
  defineField({ name: "width", type: "number", description: "Metres", validation: r => r.required().positive() }),
  defineField({ name: "depth", type: "number", description: "Metres", validation: r => r.required().positive() }),
  defineField({ name: "rotation", type: "number", description: "Radians" }),
  defineField({ name: "sourceId", type: "string" }), defineField({ name: "verified", type: "boolean" })
];
export const schemaTypes = [
  defineType({ name: "accessVenue", title: "Venue", type: "document", fields: [
    defineField({ name: "title", type: "string", validation: r => r.required() }),
    defineField({ name: "synthetic", type: "boolean", description: "Demo venue; not real observations" })
  ] }),
  defineType({ name: "spatialEntity", title: "Spatial entity", type: "document", fields: [venue(),
    defineField({ name: "entityId", type: "string", validation: r => r.required() }),
    defineField({ name: "title", type: "string", validation: r => r.required() }),
    defineField({ name: "kind", type: "string", options: { list: ["room", "door", "landmark"] } })
  ] }),
  defineType({ name: "accessSource", title: "Evidence source", type: "document", fields: [venue(),
    defineField({ name: "title", type: "string", validation: r => r.required() }),
    defineField({ name: "publisher", type: "string", validation: r => r.required() }),
    defineField({ name: "url", type: "url", validation: r => r.uri({ scheme: ["https", "http"] }) }),
    defineField({ name: "observedAt", type: "datetime", validation: r => r.required() }),
    defineField({ name: "synthetic", type: "boolean" }),
    defineField({ name: "body", type: "text", rows: 12, validation: r => r.required().max(12000) })
  ] }),
  defineType({ name: "accessClaim", title: "Access claim", type: "document", fields: [venue(), entity(), source(),
    defineField({ name: "property", type: "string", options: { list: ["step-free", "clear-width-mm"] }, validation: r => r.required() }),
    defineField({ name: "stepFree", type: "boolean", hidden: ({ document }) => document?.property !== "step-free" }),
    defineField({ name: "widthMm", type: "number", hidden: ({ document }) => document?.property !== "clear-width-mm", validation: r => r.positive() }),
    defineField({ name: "status", type: "string", options: { list: ["verified", "unverified", "disputed"] }, validation: r => r.required() })
  ] }),
  defineType({ name: "operationalNotice", title: "Dated closure", type: "document", fields: [venue(), entity(), source(),
    defineField({ name: "title", type: "string", validation: r => r.required() }),
    defineField({ name: "startsAt", type: "datetime", validation: r => r.required() }),
    defineField({ name: "endsAt", type: "datetime", validation: r => r.required().custom((value, context) =>
      !value || !context.document?.startsAt || Date.parse(value) > Date.parse(String(context.document.startsAt)) ? true : "End must follow start") }),
    defineField({ name: "status", type: "string", options: { list: ["verified", "unverified"] }, initialValue: "unverified" })
  ] }),
  defineType({ name: "accessObstacle", title: "Initial obstacle layout", type: "document", fields: [venue(), source(), ...obstacleFields()],
    description: "Initial layout for new sessions. Published moves are inspected in Access publication." }),
  defineType({ name: "accessState", title: "Access publication and review", type: "document", readOnly: true, fields: [venue(),
    defineField({ name: "runId", type: "string" }), defineField({ name: "accessVersion", type: "number" }),
    defineField({ name: "sceneVersion", type: "number" }),
    defineField({ name: "publishedObstacles", type: "array", of: [{ type: "object", name: "publishedObstacle", fields: obstacleFields() }] }),
    defineField({ name: "reviewRecords", type: "array", of: [{ type: "object", name: "reviewRecord", fields: [
      defineField({ name: "id", type: "string" }), defineField({ name: "status", type: "string" }),
      defineField({ name: "proposedAt", type: "datetime" }), defineField({ name: "decidedAt", type: "datetime" }),
      defineField({ name: "decisionReason", type: "text" }), defineField({ name: "resultingVersion", type: "number" }),
      defineField({ name: "move", type: "object", fields: [
        defineField({ name: "obstacleId", type: "string" }), defineField({ name: "roomId", type: "string" }), position(),
        defineField({ name: "rotation", type: "number" }), defineField({ name: "reason", type: "text" }),
        defineField({ name: "baseSceneVersion", type: "number" }), defineField({ name: "baseAccessVersion", type: "number" })
      ] })
    ] }] }),
    defineField({ name: "stateJson", type: "text", hidden: true, description: "Internal validated snapshot; write through the review API" })
  ] })
];
