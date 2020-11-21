import { promises as fs } from 'fs';
import pathlib from 'path';
import vm from 'vm';

import * as joi from 'typesafe-joi';
//@ts-ignore No declaration file
import deepRenameKeys from 'deep-rename-keys';

const nodeJoi = joi.object({
	name: joi.string().required(),
	comPort: joi.string().required(),
	baudRate: joi.number().integer().required(),
	byteSize: joi.number().default(8).valid(5, 6, 7, 8),
	parity: joi.string().default('none').valid('even', 'odd', 'none'),
	stop: joi.number().default(1).valid(1, 2),
	tcpPort: joi.number().required().port(),
	webLinks: joi.array().items(
		joi.string().allow('telnet', 'ssh', 'raw')
	).default([]),
	webDefaultVisible: joi.boolean().default(true),
	ssh: joi.object({
		host: joi.string().required(),
		username: joi.string().required(),
		password: joi.string().required(),
	}),
});

const deviceJoi = joi.object({
	name: joi.string().required(),
	description: joi.string(),
	category: joi.string(),
	tags: joi.array().items(
		joi.string(),
		joi.object({
			name: joi.string().required(),
			color: joi.string(),
		}),
	).default([]),
	nodes: joi.array().required().items(nodeJoi),
	//TODO commands?
	jenkinsLock: joi.string(),
});

const usersJoi = joi.object({
	identify: joi.func().required(),
	avatarSupport: joi.bool().default(false),
});

const portsFindJoi = joi.object({
	enabled: joi.bool().default(false),
	patterns: joi.object().pattern(/.+/, joi.array().items(
		joi.object({
			// joi.object().type(RegExp) doesn't work here because the RegExp class in the config file VM is different from the one here.
			// If I pass RegExp in via the VM's context, /.../ still doesn't work. new RegExp(...) does, but then the RegExp doesn't work in the server process.
			pattern: joi.string().required(),
			name: joi.string().required().min(1),
		}),
	)).default({}),
}).default({
	enabled: false,
	patterns: {},
});

// Automatic typing on this doesn't work because it's recursive. The 'Command' interface is defined manually below
const commandJoi: any = joi.object({
	label: joi.string().required(),
	icon: joi.string(),
	fn: joi.func().maxArity(1),
	submenu: joi.array().items(joi.lazy(() => commandJoi)),
}).xor('fn', 'submenu');

const webJoi = joi.object({
	port: joi.number().default(80),
	ssl: joi.object({
		key: joi.string().required(),
		cert: joi.string().required(),
		passphrase: joi.string(),
	}),
});

const configJoi = joi.object({
	// Deprecated; use web.port now
	// webPort: joi.number().integer(),
	web: webJoi,
	users: usersJoi,
	portsFind: portsFindJoi,
	devices: joi.array().required().items(deviceJoi),
	commands: joi.array().items(commandJoi),
	jenkinsUrl: joi.string(),
}).required();

// Serial Bridge 1's config file had keys with spaces in it, so for backwards compatibility, convert 'foo bar' to 'fooBar'
function renameConfigKeys(obj: object) {
	return deepRenameKeys(obj, (key: string) => key.replace(/ [a-z]/g, substring => substring[1].toUpperCase()));
}

const rootDir = (process.env.NODE_ENV === 'development')
	? pathlib.join(__dirname, '..', '..') // We're in serial-bridge/dist/server
	: pathlib.join(pathlib.dirname(process.argv[1])); // Same directory as main script

export async function loadConfig() {
	const filename = pathlib.resolve(pathlib.join(rootDir, 'config.js'));
	const buf = await fs.readFile(filename).catch(e => {
		if(e.code === 'ENOENT') {
			throw new Error(`Couldn't open configuration file: ${filename}. Did you copy the example configuration from config.example?`);
		}
		throw e;
	});
	const context = vm.createContext({
		console,
		require: __non_webpack_require__,
		setTimeout,
		__filename: filename,
	});
	vm.runInContext(buf.toString('utf8'), context, { filename });

	if(typeof context.config === 'function') {
		context.config = await context.config();
	}
	if(typeof context.config !== 'object') {
		throw new Error(`Failed to parse configuration file ${filename}: 'config' variable is not an object`);
	}
	const obj = renameConfigKeys(context.config);
	if(obj.webPort) {
		if(obj.web) {
			throw new Error(`Failed to parse configuration file ${filename}: both 'webPort' and 'web' specified. Use 'web.port' instead`);
		}
		obj.web = {
			port: obj.webPort,
		};
		delete obj.webPort;
	}
	const { error, value } = configJoi.validate(obj);
	if(error) {
		throw new Error(`Failed to parse configuration file ${filename}: ${error.message}`);
	}
	// Don't think there's a way to encode this in joi:
	for(const device of value.devices) {
		for(const node of device.nodes) {
			if((node.webLinks as string[]).indexOf('ssh') >= 0 && !node.ssh) {
				throw new Error(`Failed to parse configuration file ${filename}: Node ${device.name}.${node.name} specifies an SSH link with no SSH configuration block`);
			}
		}
	}
	return value;
}
export type Config = ReturnType<typeof loadConfig> extends Promise<infer T> ? T : never;

// This needs to be kept in-sync with 'commandJoi' above
export interface Command {
	label: string;
	icon?: string;
	// Exactly one of 'fn' or 'submenu' will be set, but encoding that in the type makes it a hassle to actually use
	fn?: () => Promise<void>;
	submenu?: Command[];
}
