import Vue from 'vue';
import feathers from '@feathersjs/feathers';
import socketio from '@feathersjs/socketio-client';
import io from 'socket.io-client';
import { ClientServices as Services, DeviceJson } from '../services';

const app = feathers<Services>();
const socket = io(window.location.protocol + '//' + (process.env.VUE_APP_SERVER_PORT ? `${window.location.hostname}:${process.env.VUE_APP_SERVER_PORT}` : window.location.host));
app.configure(socketio(socket));

export type PromiseResult<T> = {
	state: 'pending';
} | {
	state: 'resolved';
	value: T;
} | {
	state: 'rejected';
	error: Error;
}

export function unwrapPromise<T>(promise: Promise<T>): PromiseResult<T> {
	const result = {
		state: 'pending',
		value: undefined as T | undefined,
		error: undefined as Error | undefined,
	};
	promise.then(value => {
		result.value = value;
		result.state = 'resolved';
	}).catch(err => {
		result.error = err;
		result.state = 'rejected';
	});
	return result as PromiseResult<T>;
}

const devices: Promise<DeviceJson[]> = app.service('api/devices').find();

const data = {
	app,
	connected: true,
	devices: unwrapPromise(devices),
};

type RootData = typeof data;
export function rootDataComputeds(): {
	[K in keyof RootData]: {
		get: (this: Vue) => RootData[K],
		set: (this: Vue, val: RootData[K]) => void,
	}
} {
	const rtn: any = {};
	for(const k in data) {
		rtn[k] = {
			get(this: Vue) {
				return this.$root.$data[k];
			},
			set(this: Vue, val: any) {
				this.$root.$data[k] = val;
			},
		};
	}
	return rtn;
}

export function rootDataUpdater(this: Vue) {
	const rootData = this.$data as RootData;

	// Initially connected is set to true to avoid a flash of disconnected errors on page load
	// After a couple seconds, set it false if the socket still isn't connected
	const timeout = setTimeout(() => rootData.connected = false, 2000);
	socket.once('connect', () => clearTimeout(timeout));
	socket.on('connect', () => rootData.connected = true);
	socket.on('disconnect', () => rootData.connected = false);

	rootData.app.service('api/devices').on('updated', (data: { device: DeviceJson }) => {
		if(rootData.devices.state == 'resolved') {
			const idx = rootData.devices.value.findIndex(device => device.id == data.device.id);
			if(idx >= 0) {
				this.$set(rootData.devices.value, idx, data.device);
			}
		}
	});
}

export default data;
