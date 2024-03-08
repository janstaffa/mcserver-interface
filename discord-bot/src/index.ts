import { Client, Intents, MessageEmbed, TextChannel } from 'discord.js';
import dotenv from 'dotenv';
import WS from 'isomorphic-ws';
import fetch from 'node-fetch';
import ping from 'ping';
import wol from 'wol';
import {
  SERVER_ADDRESS,
  SERVER_API,
  SERVER_MAC,
  WS_ADDRESS,
} from './constants';
import { WSMessage } from './types';

dotenv.config();

const client = new Client({
  intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES],
});

(async () => {
  // wait for client to connect
  await new Promise<void>((res, rej) => {
    client.on('error', rej);
    client.on('ready', (_) => res());
  });

  console.log(`Logged in as ${client.user?.tag}!`);

  let log_channel: TextChannel;
  {
    const result = client.channels.cache.find(
      (channel) => channel.id === process.env.LOG_CHANNEL
    );
    if (result) {
      log_channel = result as TextChannel;
    }
  }
  let command_channel: TextChannel;
  {
    const result = client.channels.cache.find(
      (channel) => channel.id === process.env.COMMAND_CHANNEL
    );
    if (result) {
      command_channel = result as TextChannel;
    }
  }

  const isServerAlive = async () => {
    return await new Promise((resolve) => {
      ping.sys.probe(SERVER_ADDRESS, (isAlive) => {
        if (isAlive) {
          fetch(SERVER_API + '/api/status', {
            headers: {
              key: process.env.SECRET_KEY!,
            },
          })
            .then(() => resolve(true))
            .catch((e) => resolve(false));
          return;
        }
        resolve(false);
      });
    });
  };

  let wsConnection: WS | null = null;
  let isWSOpen = false;

  const establishWSConnection = async () => {
    return new Promise<WS>((res, rej) => {
      const retry_rate = 15 * 1000; // 15 seconds
      const call_limit = 10;
      let times_called = 0;
      const attempt = () => {
        times_called++;

        if (times_called > call_limit) {
          rej();
          return;
        }

        const ws = new WS(WS_ADDRESS, {
          headers: { key: process.env.SECRET_KEY },
        });

        ws.on('open', () => {
          clearInterval(timer);
          isWSOpen = true;
          res(ws);
        });
      };

      attempt();
      const timer = setInterval(attempt, retry_rate);
    });
  };

  const connectToWS = async () => {
    if (wsConnection || isWSOpen) return;

    const embed = new MessageEmbed()
      .setTitle('Connecting')
      .setDescription(`Response to command: ${_cmd}, issued by @${_usr}.`)
      .addField('\u200B', 'Connecting to the server.');
    command_channel.send({
      embeds: [embed],
    });

    wsConnection = await establishWSConnection().catch(() => {
      return null;
    });
    if (!wsConnection) {
      const embed = new MessageEmbed()
        .setColor('#FF0000')
        .setTitle('Error')
        .setDescription('Fatal error occured while connecting to the server.');

      command_channel.send({ embeds: [embed] });
      return;
    }
    new Promise((_, rej) => {
      wsConnection?.on('error', () => rej()).on('close', () => rej());
    }).catch(async () => {
      isWSOpen = false;
      wsConnection?.terminate();
      wsConnection?.removeAllListeners('message');
      wsConnection = null;
    });

    {
      const embed = new MessageEmbed()
        .setTitle('Connected')
        .setDescription(`Response to command: ${_cmd}, issued by @${_usr}.`)
        .addField('\u200B', 'Connected to the server.');
      command_channel.send({
        embeds: [embed],
      });
    }

    wsConnection!.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as WSMessage<any>;
      switch (parsed.code) {
        case 1001:
          if (log_channel) {
            const max_message_len = 2000;
            if (
              parsed.payload.includes(
                'Potentially Dangerous alternative prefix'
              ) ||
              parsed.payload.includes(
                'Catching dependency model net.minecraftforge.client.model.ModelLoader'
              )
            )
              return;

            let final_payload = [parsed.payload];
            if (final_payload[0].length > max_message_len) {
              const regexp = new RegExp(`.{1,${max_message_len}}`, 'g');
              final_payload = final_payload[0].match(regexp);
            }
            for (const m of final_payload) {
              log_channel.send({ content: '```' + m + '```' });
            }
          }
          break;
        case 1002:
          if (parsed.payload === 'ONLINE') {
            //starting = false;
            const embed = new MessageEmbed()
              .setColor('#00ff00')
              .setTitle('🟢 Server ONLINE')
              .setDescription('@everyone The server is online!')
              .addField(
                '\u200B',
                'You can now join it: **minecraft.janstaffa.cz**.'
              );
            command_channel.send({ embeds: [embed] });
          }
          break;
        case 1003:
          {
            const embed = new MessageEmbed()
              .setColor('#000000')
              .setTitle('Message')
              .setDescription(
                `Response to command: ${_cmd}, issued by @${_usr}.`
              )
              .addField('\u200B', parsed.payload);

            command_channel.send({ embeds: [embed] });
          }
          break;
        case 1004:
          {
            const embed = new MessageEmbed()
              .setColor('#FF0000')
              .setTitle('Error')
              .setDescription(
                `Response to command: ${_cmd}, issued by @${_usr}.`
              )
              .addField('\u200B', parsed.payload);

            command_channel.send({ embeds: [embed] });
          }
          break;
      }
    });
  };

  let _cmd: string | null = null,
    _usr: string | null = null;
  //let starting = false;
  client.on('messageCreate', async (message) => {
    const sendRequest = (path: string, method: string, body?: any) => {
      return fetch(SERVER_API + path, {
        method,
        headers: {
          key: process.env.SECRET_KEY!,
        },
        body,
      })
        .then((response) => response.text())
        .then((response) => {
          if (response !== 'OK') {
            const embed = new MessageEmbed()
              .setColor('#ff0000')
              .setTitle('Error')
              .setDescription(response);
            message.reply({
              embeds: [embed],
            });
            return;
          }
          return response;
        })
        .catch((e) => {
          console.error(e);
          const embed = new MessageEmbed()
            .setColor('#ff0000')
            .setTitle('Error')
            .setDescription('Failed to send command. Please try again.');
          message.reply({
            embeds: [embed],
          });
        });
    };

    if (message.channelId !== process.env.COMMAND_CHANNEL) return;
    const { content } = message;

    if (content.startsWith('!')) {
      const raw = content.slice(1);
      const words = raw.split(' ');
      if (words.length === 0) {
        const embed = new MessageEmbed()
          .setColor('#ff0000')
          .setTitle('Error')
          .setDescription('No command specified.');
        message.reply({ embeds: [embed] });
        return;
      }
      const command = words[0];

      _cmd = command;
      _usr = message.author.username;

      let isAlive = await isServerAlive();

      if (command !== 'start' && command !== 'status') {
        if (!isAlive) {
          const embed = new MessageEmbed()
            .setColor('#ff0000')
            .setTitle('Error')
            .setDescription('Server is offline.');
          message.reply({
            embeds: [embed],
          });
          return;
        }
      }

      if (isAlive && !isWSOpen) {
        await connectToWS();
      }

      switch (command) {
        case 'start': {
          /*if (starting) {
            const embed = new MessageEmbed()
              .setColor('#FF0000')
              .setTitle('Error')
              .setDescription('The server is already starting.');

            message.channel.send({ embeds: [embed] });
            return;
          }
          starting = true;
	  */
          log_channel.send('**Server starting...**');
          if (!isAlive) {
            const embed = new MessageEmbed()
              .setTitle('Server starting')
              .setDescription(
                `Response to command: ${_cmd}, issued by @${_usr}.`
              )
              .addField('\u200B', 'Starting the machine.');
            message.channel.send({
              embeds: [embed],
            });

            await wol.wake(SERVER_MAC, (_err, _res) => {});

            await new Promise((resolve, _) => {
              const int = setInterval(async () => {
                const alive = await isServerAlive();
                if (alive) {
                  clearInterval(int);
                  isAlive = true;
                  return resolve(true);
                }
              }, 2000);
            });
          }

          if (isAlive && !isWSOpen) {
            await connectToWS();
          }

          sendRequest('/api/start', 'POST');
          break;
        }

        case 'cmd':
          if (words.length < 2) {
            const embed = new MessageEmbed()
              .setColor('#ff0000')
              .setTitle('Error')
              .setDescription('No command specified.');
            message.reply({
              embeds: [embed],
            });
            return;
          }
          const cmd = words.slice(1, words.length).join(' ');

          const cmd_body = {
            command: cmd,
          };

          fetch(SERVER_API + '/api/command', {
            method: 'POST',
            body: JSON.stringify(cmd_body),
            headers: {
              key: process.env.SECRET_KEY!,
              'Content-Type': 'application/json',
            },
          })
            .then((response) => response.json())
            .then((response) => {
              if (response.error === 1) {
                const embed = new MessageEmbed()
                  .setColor('#ff0000')
                  .setTitle('Error')
                  .setDescription(response.message);
                message.reply({
                  embeds: [embed],
                });
                return;
              }
              const embed = new MessageEmbed()
                .setColor('#000000')
                .setTitle('Message')
                .setDescription(
                  `Response to command: ${command}, issued by @${message.author.username}.`
                )
                .addField('\u200B', response.result);
              message.channel.send({
                embeds: [embed],
              });
            })
            .catch((_) => {
              const embed = new MessageEmbed()
                .setColor('#ff0000')
                .setTitle('Error')
                .setDescription('Failed to send command: ' + cmd);
              message.reply({
                embeds: [embed],
              });
            });
          break;
        case 'status':
          if (!isAlive) {
            const embed = new MessageEmbed()
              .setTitle('Status')
              .setDescription('POWERED DOWN 🔴');
            message.reply({
              embeds: [embed],
            });
            return;
          }

          fetch(SERVER_API + '/api/status', {
            headers: {
              key: process.env.SECRET_KEY!,
            },
          })
            .then((response) => response.text())
            .then((response) => {
              let new_status = 'error';
              switch (response) {
                case 'OFFLINE':
                  new_status = 'OFFLINE  🔴';
                  break;
                case 'STARTING':
                  new_status = 'STARTING  🟠';
                  break;
                case 'STOPPING':
                  new_status = 'STOPPING 🟠';
                  break;
                case 'ONLINE':
                  new_status = 'ONLINE  🟢';
                  break;
              }
              const embed = new MessageEmbed()
                .setTitle('Status')
                .setDescription(new_status);

              message.reply({
                embeds: [embed],
              });
            })
            .catch((_) => {
              const embed = new MessageEmbed()
                .setColor('#ff0000')
                .setTitle('Error')
                .setDescription('Failed to get server status.');
              message.reply({
                embeds: [embed],
              });
            });

          break;

        case 'loadbackup':
          if (words.length < 2) {
            const embed = new MessageEmbed()
              .setColor('#ff0000')
              .setTitle('Error')
              .setDescription(
                'No backup specified. For a list of backups run: *!listbackups*'
              );
            message.reply({
              embeds: [embed],
            });
            return;
          }
          const backup_id = words.slice(1, words.length).join(' ');

          sendRequest('/api/backup/load/' + backup_id, 'POST');
          break;
        case 'listbackups':
          fetch(SERVER_API + '/api/backups', {
            headers: {
              key: process.env.SECRET_KEY!,
            },
          })
            .then((response) => response.json())
            .then((response) => {
              if (response.error === 1) {
                const embed = new MessageEmbed()
                  .setColor('#ff0000')
                  .setTitle('Error')
                  .setDescription(response.message);
                message.reply({
                  embeds: [embed],
                });
                return;
              }

              /*let content = `
              +---------------+-------------------------+----------+
              |id             |date                     |          |
              +===============+=========================+==========+
              `;*/

              const embed = new MessageEmbed()
                .setColor('#000000')
                .setTitle('Message')
                .setDescription(
                  `Response to command: ${command}, issued by @${message.author.username}.`
                );

              if (response.result.length === 0) {
                embed.addField('\u200B', 'No backups were found.');
                message.channel.send({
                  embeds: [embed],
                });
                return;
              }
              for (const backup of response.result) {
                const id = backup.id.toString();
                const date = backup.date;

                embed.addField(
                  '\u200B',
                  `id: ${id} | date: ${date} | [download](http://minecraft.janstaffa.cz:25566/api/backup/${id})`
                );
                /*content += `
                |${id + " ".repeat(15 - id.length)}|${date + " ".repeat(25 - date.length)}| [download](http://minecraft.janstaffa.cz:25566/api/backup/${id}) |
                +---------------+-------------------------+----------+
                `;*/
              }

              message.channel.send({
                embeds: [embed],
              });
            })
            .catch((e) => {
              console.error(e);
              const embed = new MessageEmbed()
                .setColor('#ff0000')
                .setTitle('Error')
                .setDescription('Failed to list backups.');
              message.reply({
                embeds: [embed],
              });
            });
          break;
        case 'stop':
        case 'shutdown':
        case 'backup':
        case 'restart':
          sendRequest('/api/' + command, 'POST');
          break;
        default: {
          const embed = new MessageEmbed()
            .setColor('#ff0000')
            .setTitle('Error')
            .setDescription('Invalid command: ' + command);
          message.reply({ embeds: [embed] });
        }
      }
    }
  });
})();
client.login(process.env.TOKEN);
