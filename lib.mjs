/**
 * @module GlobalLocalStorage
 * @description 一个通过内嵌 iframe 与中央存储核心通信，实现了持久化、带访问控制、
 *              客户端缓存、数据过期和跨标签页同步的增强型跨域存储客户端库。
 */

let coreWindow = null
let coreOrigin = null
let coreState = 'uninitialized' // 'uninitialized', 'initializing', 'ready', 'failed'
let defaultOptions = {}
let requestQueue = []
const pendingRequests = new Map()
let requestIdCounter = 0
const defaultCoreUrl = 'https://globallocalstorage.github.io/globallocalstorage'

const cache = new Map() // 客户端内存缓存
let channel = null // 广播频道实例

/**
 * 初始化模块。在使用其他 API 前必须调用此函数。
 * @param {object} [config={}] - 配置对象。
 * @param {string} [config.coreUrl] - 核心存储 (index.html) 的部署 URL。
 * @param {object} [config.defaultOptions] - 为 setItem 设置的默认选项。
 */
export function init(config = {}) {
	if (typeof window === 'undefined' || typeof document === 'undefined') {
		console.warn('GlobalLocalStorage: Non-browser environment, initialization skipped.')
		coreState = 'failed'
		return
	}

	if (coreState !== 'uninitialized' && coreState !== 'failed') {
		console.warn('GlobalLocalStorage: Already initialized or in the process of initializing.')
		return
	}

	coreState = 'initializing'
	const coreUrl = config.coreUrl || defaultCoreUrl
	coreOrigin = new URL(coreUrl).origin

	if (config.defaultOptions)
		defaultOptions = JSON.parse(JSON.stringify(config.defaultOptions))


	// 初始化并监听 BroadcastChannel
	if (!channel) {
		channel = new BroadcastChannel('global-local-storage-updates')
		channel.onmessage = (event) => {
			const { key, action } = event.data
			// 当其他页面修改数据时，更新本地缓存
			if (action === 'set' || action === 'remove')
				if (cache.has(key))
					cache.delete(key)


		}
	}

	const setupIframe = () => {
		const iframe = document.createElement('iframe')
		iframe.src = coreUrl
		iframe.style.display = 'none'
		iframe.setAttribute('aria-hidden', 'true')

		iframe.onload = () => {
			coreWindow = iframe.contentWindow
			coreState = 'ready'
			processRequestQueue()
		}

		iframe.onerror = () => {
			const error = new Error(`Failed to load the storage core iframe. URL: ${coreUrl}.`)
			console.error(`GlobalLocalStorage: ${error.message}`)
			coreState = 'failed'
			const rejectAll = (req) => pendingRequests.get(req.message.requestId)?.reject(error)
			requestQueue.forEach(rejectAll)
			pendingRequests.forEach(p => p.reject(error))
			requestQueue = []
			pendingRequests.clear()
		}

		document.documentElement.appendChild(iframe)
	}

	if (document.readyState === 'loading')
		document.addEventListener('DOMContentLoaded', setupIframe)
	else
		setupIframe()


	window.addEventListener('message', (event) => {
		if (coreState !== 'ready' || event.origin !== coreOrigin || event.source !== coreWindow)
			return


		const { action, requestId, value, error } = event.data

		if (action === 'response' && pendingRequests.has(requestId)) {
			const promiseController = pendingRequests.get(requestId)
			if (error) {
				const err = new Error(error.message)
				err.name = error.name
				promiseController.reject(err)
			} else
				promiseController.resolve(value)

			pendingRequests.delete(requestId)
		}
	})
}

function processRequestQueue() {
	while (requestQueue.length > 0) {
		const request = requestQueue.shift()
		coreWindow.postMessage(request.message, coreOrigin)
	}
}

function sendRequest(message) {
	if (coreState === 'uninitialized') {
		console.warn('GlobalLocalStorage: `init()` was not called manually. Using default configuration. Explicitly calling `init()` is recommended.')
		init()
	}

	return new Promise((resolve, reject) => {
		if (coreState === 'failed')
			return reject(new Error('GlobalLocalStorage core is in a failed state.'))

		pendingRequests.set(message.requestId, { resolve, reject })
		if (coreState === 'ready')
			coreWindow.postMessage(message, coreOrigin)
		else
			requestQueue.push({ message })

	})
}

/**
 * 将数据存入全局存储。
 * @param {string} key - 存储的键。
 * @param {any} value - 要存储的值。
 * @param {object} [options={}] - 可选参数。
 * @param {object} [options.acl] - 访问控制列表。
 * @param {number} [options.ttl] - 数据的生命周期(秒)。
 * @returns {Promise<void>}
 */
export function setItem(key, value, options = {}) {
	const requestId = requestIdCounter++
	cache.delete(key)
	const finalOptions = { ...defaultOptions, ...options }
	return sendRequest({ action: 'setItem', key, value, options: finalOptions, requestId })
}

/**
 * 从全局存储中检索数据。会优先从客户端缓存中读取。
 * @param {string} key - 要检索的键。
 * @returns {Promise<any>} 返回一个 Promise，其会解析为检索到的值。
 */
export function getItem(key) {
	if (cache.has(key))
		return Promise.resolve(cache.get(key))


	const requestId = requestIdCounter++
	return sendRequest({ action: 'getItem', key, requestId }).then(value => {
		cache.set(key, value)
		return value
	})
}

/**
 * 从全局存储中移除一个项目。
 * @param {string} key - 要移除的键。
 * @returns {Promise<void>}
 */
export function removeItem(key) {
	const requestId = requestIdCounter++
	cache.delete(key)
	return sendRequest({ action: 'removeItem', key, requestId })
}

/**
 * 清除当前源有权写入的所有项目。
 * 此操作会清空整个客户端缓存以确保一致性。
 * @returns {Promise<void>}
 */
export function clear() {
	const requestId = requestIdCounter++
	cache.clear()
	return sendRequest({ action: 'clear', requestId })
}

/**
 * 获取当前源有权读取的所有键的列表。
 * @returns {Promise<string[]>} 返回一个 Promise，其会解析为一个包含键名的数组。
 */
export function keys() {
	const requestId = requestIdCounter++
	return sendRequest({ action: 'keys', requestId })
}
