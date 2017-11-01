import request from '@dojo/core/request/providers/xhr';
import Task from '@dojo/core/async/Task';

import { RemoteEvents } from '../RemoteSuite';
import BaseChannel, { ChannelOptions, Message } from './Base';

export default class HttpChannel extends BaseChannel {
	protected _lastRequest: Task<void>;
	protected _messageBuffer: MessageEntry[];
	protected _sequence: number;
	protected _maxPostSize: number;
	protected _activeRequest: Task<any> | undefined;

	constructor(options: HttpChannelOptions) {
		super(options);
		this._sequence = 1;
		this._maxPostSize = options.maxPostSize || 100000;
		this._messageBuffer = [];
		this._lastRequest = Task.resolve();
	}

	protected _sendData(name: keyof RemoteEvents, data: any) {
		const id = String(this._sequence++);
		const sessionId = this.sessionId;
		const message: Message = { id, sessionId, name, data };
		const task = new Task(
			(resolve, reject) => {
				this._messageBuffer.push({
					message: JSON.stringify(message),
					resolve,
					reject
				});

				if (this._activeRequest) {
					this._activeRequest.then(() => this._sendMessages());
				} else {
					this._sendMessages();
				}
			},
			() => {
				if (this._activeRequest) {
					this._activeRequest.cancel();
				}
				this._messageBuffer = [];
			}
		);

		return task;
	}

	/**
	 * Some testing services have problems handling large message POSTs, so
	 * limit the maximum size of each POST body to maxPostSize bytes. Always
	 * send at least one message, even if it's more than maxPostSize bytes.
	 */
	protected _sendMessages(): Task<any> | undefined {
		const messages = this._messageBuffer;
		if (messages.length === 0) {
			return;
		}

		const block = [messages.shift()!];

		let size = block[0].message.length;
		while (
			messages.length > 0 &&
			size + messages[0].message.length < this._maxPostSize
		) {
			size += messages[0].message.length;
			block.push(messages.shift()!);
		}

		this._activeRequest = request(this.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(block.map(entry => entry.message))
		})
			.then(response => {
				return response.json<any[]>();
			})
			.then((results: any[]) => {
				block.forEach((entry, index) => {
					entry.resolve(results[index]);
				});
			})
			.catch(error => {
				block.forEach(entry => {
					entry.reject(error);
				});
			})
			.finally(() => {
				this._activeRequest = undefined;
				if (messages.length > 0) {
					return this._sendMessages();
				}
			});

		return this._activeRequest;
	}
}

export interface HttpChannelOptions extends ChannelOptions {
	maxPostSize?: number;
}

export interface MessageEntry {
	message: string;
	resolve: (value: any) => void;
	reject: (error: Error) => void;
}
