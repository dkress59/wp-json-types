import { isRecord } from '@tool-belt/type-predicates'
import fetch from 'cross-fetch'
import dtsgenerator, { parseSchema } from 'dtsgenerator'
import fs from 'fs'
import fsPromises from 'fs/promises'
import { capitalize } from 'lodash'
import path from 'path'
import rimraf from 'rimraf'

import { Collection, RestContext, RouteLevel, TopLevel } from './types'

const output = path.resolve(__dirname, '../dist')
const moduleDeclaration = "declare module 'wp-json-types' {"

const baseUrl = 'http://localhost:8080/wp-json'
const baseEP = '/wp/v2'

function _upperFirst(string: string) {
	return string.slice(0, 1).toUpperCase() + string.slice(1, string.length)
}

function _snakeToPascal(string: string) {
	return string
		.split('_')
		.map(str => {
			return _upperFirst(str.split('/').map(_upperFirst).join('/'))
		})
		.join('')
}

function transformForContext(
	entry: Record<string, unknown>,
	context: RestContext,
) {
	const copy = { ...entry }
	const keys = Object.keys(copy)
	if (
		keys.includes('context') &&
		Array.isArray(copy.context) &&
		!copy.context.includes(context)
	)
		return undefined
	keys.forEach(key => {
		const value = copy[key]
		if (isRecord(value)) {
			const transformed = transformForContext(value, context)
			if (transformed) copy[key] = { ...transformed }
			else delete copy[key]
		}
	})
	return copy
}

async function endpointToDts({ uri, postSchema }: Collection) {
	const route = uri.replace(baseEP, '')
	// OPTIONS (schema)
	const response = await fetch(baseUrl + baseEP + route, {
		method: 'options',
	})
	const rawSchema = JSON.stringify(await response.json())
	const { schema } = JSON.parse(
		rawSchema.replaceAll('"bool"', '"boolean"'), // wtf
	) as TopLevel
	const title = schema.title.replace('wp_', 'wp-')

	const contexts = (['view', 'edit', 'embed'] as RestContext[]).map(
		async context => {
			try {
				const transformed = transformForContext(schema, context)
				const types = await dtsgenerator({
					contents: [
						parseSchema({
							...transformed,
							id: `http://${context}.context/Wp${capitalize(
								title.replace('wp-', ''),
							)}`,
							title: capitalize(schema.title),
						}),
					],
				})
				if (types.includes('{}')) {
					await fsPromises.writeFile(
						path.resolve(__dirname) + '/error.log',
						JSON.stringify({ context, title }),
						{ mode: 'a' },
					)
					return Promise.resolve(null) //FIXME
				}

				const fileName = `${context}.${title}.d.ts`
				console.debug(`writing ${fileName}`)
				return fsPromises.writeFile(
					path.resolve(output, `./${context}/${fileName}`),
					types.replaceAll('?: ', ': '),
				)
			} catch (error) {
				console.error(error)
			}
		},
	)
	await Promise.all(contexts)

	if (postSchema)
		try {
			postSchema = JSON.parse(
				JSON.stringify(postSchema)
					.replaceAll(',"required":true', '')
					.replaceAll(',"required":false', ''),
			) as Record<string, unknown>
			const postTypes = await dtsgenerator({
				contents: [
					parseSchema({
						$schema: 'http://json-schema.org/draft-04/schema#',
						type: 'object',
						id: `http://create.context/Wp${capitalize(
							title.replace('wp-', ''),
						)}`,
						title: capitalize(schema.title),
						// eslint-disable-next-line @typescript-eslint/ban-ts-comment
						// @ts-ignore
						properties: postSchema,
					}),
				],
			})

			const fileName = `create.${title}.d.ts`
			console.debug(`writing ${fileName}`)
			return fsPromises.writeFile(
				path.resolve(output, `./create/${fileName}`),
				postTypes,
			)
		} catch (error) {
			console.error(error)
		}
}

function trimData(data: string): string {
	const split = data.split('\n')
	return split.slice(1, split.length - 2).join('\n')
}

async function trimFile(file: string): Promise<string> {
	file = path.resolve(output, `./${file}`)
	const data = await fsPromises.readFile(file, 'utf8')
	return '\n' + trimData(data) + '\n'
}

async function compressFinal(output: string): Promise<string> {
	const createContext = await fsPromises.readdir(
		path.resolve(output, './create'),
	)
	const embedContext = await fsPromises.readdir(
		path.resolve(output, './embed'),
	)
	const editContext = await fsPromises.readdir(path.resolve(output, './edit'))
	const viewContext = await fsPromises.readdir(path.resolve(output, './view'))

	console.debug('---')
	console.debug('writing index.d.ts')

	let final = moduleDeclaration

	for await (const file of viewContext)
		final += await trimFile('./view/' + file)

	final += '\nexport namespace CreateContext {\n'
	for await (const file of createContext)
		final += await trimFile('./create/' + file)
	final += '\n}\n'

	final += '\nexport namespace EditContext {\n'
	for await (const file of editContext)
		final += await trimFile('./edit/' + file)
	final += '\n}\n'

	final += '\nexport namespace EmbedContext {\n'
	for await (const file of embedContext)
		final += await trimFile('./embed/' + file)
	final += '\n}\n'

	final += '\n}\n'

	return final
}

async function makeOutputDir(): Promise<void> {
	if (!fs.existsSync(output)) await fsPromises.mkdir(output)
}

async function deleteOutputDir(): Promise<void> {
	await new Promise((resolve, reject) => {
		rimraf(output, {}, error => (error ? reject(error) : resolve(null)))
	})
}

async function writeCommonTypesToFile(
	commonTypeExports: string[],
): Promise<void> {
	await fsPromises.writeFile(
		output + '/common.ts',
		commonTypeExports.join('\n\n'),
		'utf8',
	)
}

async function extractCommonTypes(): Promise<void> {
	const bundle = (
		await fsPromises.readFile(path.resolve(output, './index.d.ts'))
	).toString()

	const interestingUnion = new RegExp(
		/([a-z_]+)\??: \(?"([^;]+)"\)?[\w\s_|[\]]*;/,
	)
	const contextRegExp = new RegExp(/export namespace ([\w]+) {/g)

	const contexts = Array.from(bundle.matchAll(contextRegExp)).map(
		match => match[1],
	)
	contexts.unshift('ViewContext')

	const commonTypeExports: { name: string; exportString: string }[] = []
	const interfacesPerContext = bundle.split('export namespace')
	interfacesPerContext.forEach((contextAsString, iteration) => {
		const contextName = contexts[iteration]
			.replace('ViewContext', '')
			.replace('Context', '')
		const currentContextLines = contextAsString.split('\n')
		const replacedLines = currentContextLines.map(
			(line, relativeLineNumber) => {
				const matchedUnion = line.match(interestingUnion)
				if (matchedUnion && matchedUnion.length > 2) {
					// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
					const parentObjectName = [...currentContextLines]
						.slice(0, relativeLineNumber)
						.reverse()
						.find(line => line.includes('export interface'))!
						.match(/export interface ([\w]+) {/)![1]
						.replace('Wp', '')
					const name = `Wp${contextName}${parentObjectName}${_snakeToPascal(
						matchedUnion[1],
					)}`
					const unionType = matchedUnion[2]
					commonTypeExports.push({
						name,
						exportString: `export type ${name} = "${unionType}"`,
					})
					return line.replace(`"${unionType}"`, name)
				}
				return line
			},
		)
		interfacesPerContext[iteration] = replacedLines.join('\n')
	})
	await writeCommonTypesToFile(
		commonTypeExports.map(({ exportString }) => exportString),
	)

	const importStatement = `import {${commonTypeExports
		.map(({ name }) => name)
		.join(', ')}} from './common'`
	const newBundle = interfacesPerContext
		.join('export namespace')
		.replace(
			moduleDeclaration,
			importStatement +
				'\n' +
				moduleDeclaration +
				"\n\texport * from './common'",
		)
	await fsPromises.writeFile(path.resolve(output, './index.d.ts'), newBundle)
}

async function main() {
	await deleteOutputDir()
	await makeOutputDir()
	if (!fs.existsSync(output + '/view'))
		await fsPromises.mkdir(output + '/view')
	if (!fs.existsSync(output + '/edit'))
		await fsPromises.mkdir(output + '/edit')
	if (!fs.existsSync(output + '/embed'))
		await fsPromises.mkdir(output + '/embed')
	if (!fs.existsSync(output + '/create'))
		await fsPromises.mkdir(output + '/create')

	// GET (routes)
	const { routes } = (await (await fetch(baseUrl + baseEP)).json()) as {
		routes: Record<string, RouteLevel>
	}

	const endpoints: Collection[] = Object.values(routes)
		.slice(1)
		.map((route, i) => {
			const uri = Object.keys(routes).slice(1)[i]
			const postSchema =
				route.endpoints.length > 1 ? route.endpoints[1].args : undefined
			return {
				uri,
				postSchema,
			}
		})
		.filter(route => !route.uri.endsWith(')'))
		.filter(route => !route.uri.includes('<'))
		.filter(route => !route.uri.includes('search'))
		// FIXME: dts-generation for block- & pattern-directory endpoints
		.filter(route => !route.uri.includes('directory'))

	await Promise.all(endpoints.map(endpointToDts))

	const final = await compressFinal(output)

	await deleteOutputDir()
	await makeOutputDir()

	await fsPromises.writeFile(output + '/index.d.ts', final, 'utf8')

	await extractCommonTypes()
}

void main()
