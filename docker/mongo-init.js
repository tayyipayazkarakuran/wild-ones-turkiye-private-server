const appDb = db.getSiblingDB(process.env.DB_NAME || "emu");
appDb.createUser({ user: process.env.MONGO_APP_USERNAME, pwd: process.env.MONGO_APP_PASSWORD, roles: [{ role: "readWrite", db: appDb.getName() }] });
