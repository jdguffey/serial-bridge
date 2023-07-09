import axios, { AxiosBasicCredentials } from 'axios';
import xml2js from 'xml2js';

import { EventEmitter } from 'events';

interface Stage {
	name: string;
	start: Date;
	tasks: Task[];
}

interface Task {
	name: string;
	start: Date;
}

export default class Build extends EventEmitter {
	public readonly start: Date;
	private _result?: boolean;
	private stages: Stage[] = [];

	constructor(public readonly device: string, public readonly name: string, public readonly link: string | undefined, public readonly fromXml: boolean) {
		super();
		this.start = new Date();
	}

	get currentStage(): Stage | undefined {
		return this.stages.length > 0 ? this.stages[this.stages.length - 1] : undefined;
	}

	get currentTask(): Task | undefined {
		const stage = this.currentStage;
		return (stage && stage.tasks.length > 0) ? stage.tasks[stage.tasks.length - 1] : undefined;
	}

	get result(): boolean | undefined {
		return this._result;
	}

	set result(result: boolean | undefined) {
		this._result = result;
		this.emit('updated', 'result', result);
	}

	pushStage(name: string): Stage {
		const stage: Stage = {
			name,
			start: new Date(),
			tasks: [],
		};
		this.stages.push(stage);
		this.emit('updated', 'pushStage', stage);
		return stage;
	}

	popStage() {
		if(this.stages.length > 0) {
			this.stages.splice(this.stages.length - 1, 1);
			this.emit('updated', 'popStage');
		}
	}

	pushTask(name: string): Task {
		let stage = this.currentStage;
		if(!stage) {
			stage = this.pushStage("<Unknown stage>");
		}
		const task: Task = {
			name,
			start: new Date(),
		};
		stage.tasks.push(task);
		this.emit('updated', 'pushTask', task);
		return task;
	}

	popTask() {
		const stage = this.currentStage;
		if(stage && stage.tasks.length > 0) {
			stage.tasks.splice(stage.tasks.length - 1, 1);
			this.emit('updated', 'popTask');
		}
	}

	toJSON() {
		const { device, name, link, start, currentStage, currentTask, result } = this;
		return {
			device,
			name, link, start,
			stage: currentStage ? {
				name: currentStage.name,
				start: currentStage.start,
			} : undefined,
			task: currentTask ? {
				name: currentTask.name,
				start: currentTask.start,
			} : undefined,
			result,
		};
	}

	static makeFrom(build: Build): Build {
		const rtn = new Build(build.device, build.name, build.link, build.fromXml);
		rtn.start.setTime(build.start.getTime());
		rtn._result = build._result;
		rtn.stages = build.stages;
		return rtn;
	}
}

interface Locks {
	[K: string]: {
		owner: string;
		type: 'user' | 'build';
		date: Date | undefined;
	};
};

// Takes the config file generated by the Lockable Resources Jenkins plugin ( https://plugins.jenkins.io/lockable-resources ).
// Returns an object mapping lock name to the user/build who has it. Free locks are omitted.
export async function parseLockXml(xml: string): Promise<Locks> {
	const parser = new xml2js.Parser({
		explicitArray: false,
		ignoreAttrs: true,
	});
	const data = await parser.parseStringPromise(xml);
	if(!data) {
		throw new Error("Failed to parse XML");
	}
	// console.log(util.inspect(data, false, null))
	let resources = data;
	for(const k of ['org.jenkins.plugins.lockableresources.LockableResourcesManager', 'resources', 'org.jenkins.plugins.lockableresources.LockableResource']) {
		resources = resources[k];
		if(!resources) {
			throw new Error(`XML missing key '${k}'`);
		}
	}
	if(!Array.isArray(resources)) {
		resources = [ resources ];
	}

	const rtn: Locks = {};
	for(const resource of resources) {
		if(resource.name) {
			if(resource.reservedBy) {
				rtn[resource.name] = {
					owner: resource.reservedBy,
					type: 'user',
					date: resource.reservedTimestamp ? new Date(resource.reservedTimestamp) : undefined,
				};
			} else if(resource.buildExternalizableId) {
				rtn[resource.name] = {
					owner: resource.buildExternalizableId,
					type: 'build',
					date: undefined,
				};
			}
		}
	}
	return rtn;
}

async function getJenkinsCSRFToken(jenkinsBaseUrl: string, auth: AxiosBasicCredentials): Promise<{ [K: string]: string; }> {
	const resp = await axios.get(`${jenkinsBaseUrl}/crumbIssuer/api/json`, {
		auth,
		validateStatus: status => status == 200 || status == 401,
	}).catch(e => {
		throw new Error(`Failed to communicate with Jenkins: ${e.message ?? e}`);
	});
	if(resp.status == 401) {
		throw new Error("Failed to communicate with Jenkins: " + (resp.data.message ?? "likely invalid API key"));
	}
	const { crumb, crumbRequestField } = resp.data;
	if(!crumb || !crumbRequestField) {
		throw new Error("Unexpected response from Jenkins crumb generator");
	}
	return {
		[crumbRequestField]: crumb,
	};
}

export async function checkJenkinsApiKey(jenkinsBaseUrl: string, jenkinsUsername: string, jenkinsApiKey: string) {
	await getJenkinsCSRFToken(jenkinsBaseUrl, {
		username: jenkinsUsername,
		password: jenkinsApiKey,
	});
}

export async function setLockReservation(jenkinsBaseUrl: string, jenkinsUsername: string, jenkinsApiKey: string, lockName: string, action: 'reserve' | 'unreserve') {
	const auth: AxiosBasicCredentials = {
		username: jenkinsUsername,
		password: jenkinsApiKey,
	};
	const token = await getJenkinsCSRFToken(jenkinsBaseUrl, auth);
	await axios.post(`${jenkinsBaseUrl}/lockable-resources/${action}`, undefined, {
		params: {
			resource: lockName,
		},
		auth,
		headers: token,
	}).catch(e => {
		throw new Error(`Failed to communicate with Jenkins lock manager: ${e.message ?? e}`);
	});
}
