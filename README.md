<img width=150 align="right" src="https://raw.githubusercontent.com/zakandaiev/node-fastify-starter/refs/heads/main/public/favicon.svg" alt="Node.js Logo">

# node-fastify-starter

Node.js Fastify Starter is a boilerplate kit for building modern backend applications

## Features
* Node.js engine
* Fastify ecosystem
* MariaDB database
* Swagger documentation
* Docker friendly
* User authentication and authorization ready
* Well thought-out and convenient project structure
* Live-server with hot-reload
* Useful utils
* index html page
* And many more...

## How to use

Prerequisites:
* [Node.js](https://nodejs.org/) (`>=22`)
* [MariaDB](https://mariadb.org/) (`>=11.7`)

### Install

``` bash
# Clone the repository
git clone https://github.com/zakandaiev/node-fastify-starter.git

# Go to the folder
cd node-fastify-starter

# Install
npm i
# or
npm install

# Remove link to the original repository
# - if you use Windows system
Remove-Item .git -Recurse -Force
# - or if you use Unix system
rm -rf .git
```

### Develop

``` bash
# Start development mode with live-server
npm run dev
# or with options
npm run dev -- --port=3000
```

### Start

``` bash
# Start production process
npm run start
# or with options
npm run start -- --port=3000
```

### Migration

``` bash
npm run migration:up
# or
npm run migration:down
# or exclude
npm run migration:up -- --names-exclude=dummy,dummy_column_name
# or only specific migrations
npm run migration:up -- --names=dummy,dummy_column_name
```

### Seed

``` bash
npm run seed:up
# or
npm run seed:down
# or exclude
npm run seed:up -- --names-exclude=dummy
# or only specific seeds
npm run seed:up -- --names=dummy
```

### Lint

``` bash
# ESLint
npm run lint
# or
npm run lint:fix
```
