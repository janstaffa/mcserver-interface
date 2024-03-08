# MCserver interface
Minecraft server interface using a Discord bot as a frontend. This project allows you to keep only a light program running (Discord bot) for example on a Raspberry PI, which then remotely starts a more powerful computer which hosts the server itself. This configuration allows for great power savings, since the computer with much higher consumption only runs when requested.
## Contents
This project contains two programs:
- [The server API](https://github.com/janstaffa/mcserver-interface/tree/master/server-api) which takes care of starting and controlling the Minecraft server Java instance
- [The Discord bot](https://github.com/janstaffa/mcserver-interface/tree/master/discord-bot) which boots the computer running the server API and sends commands to it over a local network
