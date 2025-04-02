const {InstanceBase, InstanceStatus, runEntrypoint, combineRgb} = require('@companion-module/base')
const dgram = require('dgram') // Модуль Node.js для работы с UDP

// Команда обнаружения из вашей документации
const DISCOVERY_COMMAND_HEX = 'a56c140081ff01000000000000000000ffa503ae'
const BROADCAST_ADDRESS = '255.255.255.255'

class GenericUdpSwitcherInstance extends InstanceBase {
    constructor(internal) {
        super(internal)
        this.udpSocket = null
        this.config = {}
        this.discoveredDevices = {} // Для хранения обнаруженных устройств (IP -> {lastSeen, name})
    }

    // Вызывается при инициализации модуля или обновлении конфигурации
    async init(config) {
        this.config = config
        this.log('info', `Initializing module instance...`)

        // Сбрасываем статус и обнаруженные устройства при реинициализации
        this.updateStatus(InstanceStatus.Connecting, 'Initializing UDP')
        this.discoveredDevices = {}

        // Инициализируем UDP сокет
        this.initUDP()

        // Инициализируем доступные действия
        this.initActions()

        // Инициализируем доступные фидбеки (пока нет, но структура есть)
        // this.initFeedbacks()

        // Инициализируем пресеты (пока нет, но структура есть)
        // this.initPresets()
    }

    // Вызывается при удалении или отключении модуля
    async destroy() {
        this.log('info', 'Destroying module instance')
        if (this.udpSocket) {
            // Корректно закрываем сокет
            try {
                this.udpSocket.close(() => {
                    this.log('info', 'UDP Socket closed')
                })
                this.udpSocket = null // Убираем ссылку
            } catch (e) {
                this.log('error', `Error closing UDP socket: ${e.message}`)
            }
        }
        // Устанавливаем статус "отключено"
        this.updateStatus(InstanceStatus.Disconnected)
    }

    // Определяет поля конфигурации, которые видит пользователь в Companion
    getConfigFields() {
        return [
            {
                type: 'static-text',
                id: 'info',
                width: 12,
                label: 'Information',
                value: 'Этот модуль управляет Multiviewer/Matrix Switcher по UDP. Используйте действие "Discover Device" для поиска устройства в сети.',
            },
            {
                type: 'textinput', // Поле для ввода IP-адреса устройства
                id: 'host',
                label: 'Target Device IP',
                width: 6,
                // regex: Regex.IP, // Можно добавить валидацию IP, если InstanceBase это поддерживает
                tooltip: 'Введите IP-адрес устройства после его обнаружения или если он известен',
                default: '', // По умолчанию пусто, т.к. мы его ищем
            },
            {
                type: 'number', // Поле для ввода порта
                id: 'port',
                label: 'Target Port',
                width: 6,
                min: 1,
                max: 65535,
                default: 7000, // Порт из документации
                required: true,
            },
            // Можно добавить поле для выбора обнаруженного устройства, если их несколько
            // {
            //     type: 'dropdown',
            //     id: 'discovered_device',
            //     label: 'Discovered Device (refresh actions)',
            //     width: 6,
            //     choices: Object.keys(this.discoveredDevices).map(ip => ({ id: ip, label: ip })),
            //     default: '',
            // }
        ]
    }

    // Вызывается при изменении конфигурации пользователем
    async configUpdated(config) {
        this.log('info', 'Configuration updated. Re-initializing...')
        await this.init(config) // Переинициализируем модуль с новой конфигурацией
    }

    // --- Основные функции модуля ---

    initUDP() {
        // Закрываем существующий сокет, если он есть, перед созданием нового
        if (this.udpSocket) {
            try {
                this.udpSocket.close()
            } catch (e) {
                this.log('debug', `Ignoring error closing previous socket: ${e.message}`)
            }
            this.udpSocket = null
        }

        this.log('debug', 'Creating UDP socket...')
        // Создаем UDP4 (IPv4) сокет
        this.udpSocket = dgram.createSocket('udp4')

        // Обработчик входящих сообщений
        this.udpSocket.on('message', (msg, rinfo) => {
            const messageHex = msg.toString('hex')
            this.log('debug', `UDP Message received from ${rinfo.address}:${rinfo.port} - HEX: ${messageHex}`)

            // --- Обработка ответа на команду обнаружения ---
            // Сравниваем начало ответа с тем, что указано в документации (a5 6c 2c 00 a1 ff...)
            const expectedResponsePrefixHex = 'a56c2c00a1ff'
            if (messageHex.startsWith(expectedResponsePrefixHex)) {
                this.log('info', `Device Discovery Response from ${rinfo.address}`)
                this.discoveredDevices[rinfo.address] = {
                    lastSeen: Date.now(),
                    // Можно попытаться извлечь имя из ответа, если оно там есть в ASCII
                    // name: msg.toString('ascii', 20, msg.indexOf(0x0d, 20)) // Пример, нужны точные смещения
                }
                // Устанавливаем статус ОК, если получили ответ
                this.updateStatus(InstanceStatus.Ok, `Device found at ${rinfo.address}`)
                // Опционально: Обновить выпадающий список устройств, если он есть в конфиге
                // this.initActions() // Обновить действия, если они зависят от обнаруженных устройств
                // this.setConfigFields(this.getConfigFields()) // Обновить поля конфига
            }

            // --- TODO: Обработка других ответов от устройства ---
            // Здесь будет логика разбора ответов на команды коммутации, запросы статуса и т.д.
            // Эта логика будет обновлять внутреннее состояние модуля для фидбеков.
        })

        // Обработчик ошибок сокета
        this.udpSocket.on('error', (err) => {
            this.log('error', `UDP Socket error: ${err.message}`)
            this.updateStatus(InstanceStatus.ConnectionFailure, `UDP Error: ${err.stack}`)
            if (this.udpSocket) {
                try {
                    this.udpSocket.close();
                } catch (e) {
                } // Пытаемся закрыть
                this.udpSocket = null;
            }
            // Можно добавить логику переподключения через некоторое время
        })

        // Обработчик события "прослушивание"
        this.udpSocket.on('listening', () => {
            const address = this.udpSocket.address()
            this.log('info', `UDP Listener active on ${address.address}:${address.port}`)
            try {
                // Включаем возможность отправки широковещательных пакетов
                this.udpSocket.setBroadcast(true)
                this.log('debug', 'UDP Broadcast enabled.')
                // Статус может быть "Неизвестно" или "Ошибка", пока устройство не найдено
                this.updateStatus(InstanceStatus.UnknownWarning, 'Ready to discover')
            } catch (e) {
                this.log('error', `Failed to set broadcast: ${e.message}`)
                this.updateStatus(InstanceStatus.ConnectionFailure, 'Broadcast Error')
            }
        })

        // Пытаемся привязать сокет к любому адресу и случайному порту для прослушивания ответов
        try {
            this.udpSocket.bind() // ОС выберет порт
        } catch (e) {
            this.log('error', `Failed to bind UDP socket: ${e.message}`)
            this.updateStatus(InstanceStatus.ConnectionFailure, `Bind Error: ${e.message}`)
            this.udpSocket = null
        }
    }

    // Определяем действия, которые будут доступны пользователю в Companion
    initActions() {
        const actions = {
            discover_device: {
                name: 'Discover Device',
                options: [],
                callback: async (action) => {
                    this.log('info', 'Action: Discover Device triggered')
                    // Отправляем команду обнаружения широковещательно
                    this.sendUDPCommand(DISCOVERY_COMMAND_HEX, BROADCAST_ADDRESS, this.config.port)
                },
            },
            send_hex_command: {
                name: 'Send Custom HEX Command',
                options: [
                    {
                        type: 'textinput',
                        label: 'HEX Command (e.g., a56c...)',
                        id: 'hex_command',
                        default: '',
                        useVariables: true, // Разрешить использование переменных Companion
                    },
                    {
                        type: 'textinput',
                        label: 'Target IP (optional, uses config if empty)',
                        id: 'target_ip',
                        default: '',
                        useVariables: true,
                    }
                ],
                callback: async (action, context) => {
                    const targetIpOption = await context.parseVariablesInString(action.options.target_ip);
                    const hexCmd = await context.parseVariablesInString(action.options.hex_command);

                    const targetIp = targetIpOption || this.config.host; // Используем IP из опций или из конфига
                    const targetPort = this.config.port;

                    if (!targetIp) {
                        this.log('warn', `Action 'Send Custom HEX': No target IP configured or provided.`);
                        return;
                    }
                    if (!hexCmd) {
                        this.log('warn', `Action 'Send Custom HEX': No HEX command provided.`);
                        return;
                    }

                    this.log('info', `Action: Send HEX '${hexCmd}' to ${targetIp}:${targetPort}`);
                    this.sendUDPCommand(hexCmd, targetIp, targetPort);
                }
            },
            // --- TODO: Добавить конкретные действия ---
            // Например, действие для коммутации входа на выход:
            // route_input_output: {
            //     name: 'Route Input to Output',
            //     options: [
            //         { type: 'number', label: 'Input (1-16)', id: 'input', min: 1, max: 16, default: 1 },
            //         { type: 'number', label: 'Output (1-16)', id: 'output', min: 1, max: 16, default: 1 },
            //     ],
            //     callback: async (action, context) => {
            //         const input = action.options.input;
            //         const output = action.options.output;
            //         // 1. Сформировать правильный HEX пакет для этой команды согласно API Guide
            //         //    (включая корректные байты для входа/выхода и контрольную сумму, если нужна)
            //         const commandHex = this.generateRouteChangeCommand(input, output); // Нужна эта функция
            //         this.log('info', `Action: Route Input ${input} to Output ${output}`);
            //         this.sendUDPCommand(commandHex, this.config.host, this.config.port);
            //     }
            // }
        }
        this.setActionDefinitions(actions)
    }

    // Функция для отправки UDP команд
    sendUDPCommand(hexCommand, targetIp, targetPort) {
        if (!this.udpSocket) {
            this.log('warn', 'UDP socket is not initialized. Cannot send command.')
            this.updateStatus(InstanceStatus.ConnectionFailure, 'Socket unavailable')
            return
        }
        if (!targetIp || !targetPort) {
            this.log('warn', `Cannot send command: Target IP (${targetIp}) or Port (${targetPort}) is missing. Check module configuration.`)
            return
        }

        let buffer
        try {
            // Убираем пробелы из HEX строки и преобразуем в буфер байт
            const cleanedHex = hexCommand.replace(/\s+/g, '');
            if (cleanedHex.length % 2 !== 0) {
                this.log('error', `Invalid HEX string (odd length): ${cleanedHex}`)
                return
            }
            buffer = Buffer.from(cleanedHex, 'hex')
        } catch (e) {
            this.log('error', `Failed to create buffer from HEX command "${hexCommand}": ${e.message}`)
            return
        }

        this.log('debug', `Sending UDP packet to ${targetIp}:${targetPort} - HEX: ${buffer.toString('hex')}`)

        // Отправляем буфер
        this.udpSocket.send(buffer, 0, buffer.length, targetPort, targetIp, (err) => {
            if (err) {
                this.log('error', `UDP send error to ${targetIp}:${targetPort}: ${err.message}`)
                // Не меняем статус на ошибку при каждой неудачной отправке,
                // но можно добавить счетчик ошибок или другую логику
            } else {
                this.log('debug', 'UDP packet sent successfully.')
            }
        })
    }

    // --- TODO: Функции для генерации команд ---
    // generateRouteChangeCommand(input, output) {
    //    // Здесь будет логика формирования HEX строки команды коммутации
    //    // на основе номеров входа/выхода и правил из API Guide
    //    // Важно учесть формат данных и расчет контрольной суммы, если она требуется
    //    const inputByte = input.toString(16).padStart(2, '0'); // Пример, может быть не так
    //    const outputByte = output.toString(16).padStart(2, '0'); // Пример
    //    const commandBase = 'a56c.....'; // Базовая часть команды
    //    let command = `${commandBase}${inputByte}${outputByte}...`;
    //    // const checksum = calculateChecksum(command); // Нужна функция расчета КС
    //    // command += checksum;
    //    return command;
    // }

    // --- TODO: Функции для обработки ответов и обновления фидбеков ---
    // processStatusResponse(messageHex) {
    //    // Разбор ответа о статусе
    //    // Обновление внутреннего состояния (this.currentState = ...)
    //    // Вызов this.checkFeedbacks('output_status', 'input_routed_to_output', ...)
    // }
}

// Запускаем модуль
runEntrypoint(GenericUdpSwitcherInstance, [
    // Сюда можно добавить скрипты для миграции конфигурации между версиями модуля
])
