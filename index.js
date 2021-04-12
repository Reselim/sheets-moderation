const fastify = require("fastify")
const axios = require("axios")
const sheets = require("google-spreadsheet")
const fastJsonStringify = require("fast-json-stringify")

const config = require("./config.json")
const key = require("./key.json")

// Sheets service

let currentPayloadJson
let currentPayloadBinary

const encodeJsonPayload = fastJsonStringify({
	title: "Payload",
	type: "array",
	of: {
		type: "object",
		properties: {
			userId: "integer",
			type: "string",
			reason: "string",
		},
	},
})

function encodeBinaryPayload(rows) {
	const segments = []

	for (let index = 0; index < rows.length; index++) {
		let row = rows[index]
		let buffer = Buffer.alloc(7)

		buffer.writeUIntBE(row.userId, 0, 5)
		buffer.writeUInt8(config.types.indexOf(row.type), 5)
		buffer.writeUInt8(config.reasons.indexOf(row.reason), 6)

		segments.push(buffer)
	}

	return Buffer.concat(segments)
}

async function startSheetsService() {
	const document = new sheets.GoogleSpreadsheet(config.document)

	await document.useServiceAccountAuth(key)
	await document.loadInfo()

	const sheet = document.sheetsByIndex[0]

	async function fetch() {
		let rows = await sheet.getRows()

		rows = rows.map((row) => {
			return {
				userId: parseInt(row.userId),
				type: row.type,
				reason: row.reason,
			}
		})

		currentPayloadJson = encodeJsonPayload(rows)
		currentPayloadBinary = encodeBinaryPayload(rows)
	}

	await fetch()
	setInterval(fetch, config.fetchInterval)

	return sheet
}

// Rest API

async function startRestService(sheet) {
	const app = fastify()

	app.addHook("onRequest", (request, reply, done) => {
		let authorization = request.headers.authorization

		if (authorization) {
			let [ type, token ] = authorization.split(" ")

			if (type === "Bearer" && key) {
				if (config.keys.indexOf(token) !== -1) {
					done()
				} else {
					reply.status(401).send({
						error: "Invalid token",
					})
				}
			} else {
				reply.status(400).send({
					error: "Invalid Authorization header",
				})
			}
		} else {
			reply.status(400).send({
				error: "Missing Authorization header",
			})
		}
	})

	app.route({
		method: "GET",
		path: "/:format",

		schema: {
			params: {
				type: "object",
				properties: {
					format: { type: "string", enum: [ "json", "binary" ] },
				},
			},
		},

		handler(request, reply) {
			let format = request.params.format

			reply.status(200)

			if (format === "json") {
				reply.header("Content-Type", "application/json")
				reply.send(currentPayloadJson)
			} else if (format === "binary") {
				reply.header("Content-Type", "application/octet-stream")
				reply.send(currentPayloadBinary)
			}
		},
	})

	app.route({
		method: "POST",
		path: "/",

		schema: {
			body: {
				type: "object",
				properties: {
					userId: { type: "integer" },
					type: { type: "string", enum: config.types },
					reason: { type: "string", enum: config.reasons },
					notes: { type: "string" },
				},
				required: [ "userId", "type", "reason" ],
			},
		},

		async handler(request, reply) {
			let body = request.body

			let response = await axios(`https://users.roblox.com/v1/users/${body.userId}`)
			let user = response.data

			await sheet.addRow({
				username: user.name,
				type: body.type,
				reason: body.reason,
				notes: body.notes,
				userId: body.userId,
			})

			reply.status(201).send()
		},
	})

	return app.listen(config.port)
}

// Init

startSheetsService().then(startRestService).catch(console.error)