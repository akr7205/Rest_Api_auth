const express = require("express");
const DataStore = require("nedb-promises");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const config = require("./config");
// Initialize express
const app = express();

// Configure body parser
app.use(express.json());

const users = DataStore.create("Users.db");
const userRefreshTokens = DataStore.create("UserRefreshTokens.db");
const userInvalidTokens = DataStore.create("UserInvalidTokens.db");

app.get("/", (req, res) => {
  res.send("REST API Authentication and Authorization");
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(422).json({
        message: "Please fill in all fields (name, email, and password)",
      });
    }

    if (await users.findOne({ email })) {
      return res.status(409).json({ message: "Email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await users.insert({
      name,
      email,
      password: hashedPassword,
      role: role ?? "member",
    });

    return res.status(201).json({
      message: "User registered successfully",
      id: newUser._id,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(422)
        .json({ message: "Please fill in all fields (email and password)" });
    }

    const user = await users.findOne({ email });

    if (!user) {
      return res.status(401).json({ message: "Email or password is invalid" });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({ message: "Email or password is invalid" });
    }

    const accessToken = jwt.sign(
      { userId: user._id },
      config.accessTokenSecret,
      { subject: "accessApi", expiresIn: config.accessTokenExpiresIn }
    );
    const refreshToken = jwt.sign(
      { userId: user._id },
      config.refreshTokenSecret,
      { subject: "refreshToken", expiresIn: config.refreshTokenExpiresIn }
    );
    await userRefreshTokens.insert({
      refreshToken,
      userId: user._id,
    });
    return res.status(200).json({
      id: user._id,
      name: user.name,
      email: user.email,
      accessToken,
      refreshToken,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post("/api/auth/refresh-token", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    console.log(refreshToken);

    if (!refreshToken) {
      return res.status(401).json({ message: "Refresh token not found" });
    }

    const decodedRefreshToken = jwt.verify(
      refreshToken,
      config.refreshTokenSecret
    );
    // console.log("decodedRefreshToken", decodedRefreshToken);

    const userRefreshToken = await userRefreshTokens.findOne({
      refreshToken,
      userId: decodedRefreshToken.userId,
    });
    // console.log("userRefreshToken", userRefreshToken);

    if (!userRefreshToken) {
      return res
        .status(401)
        .json({ message: "Refresh token invalid or expired" });
    }

    await userRefreshTokens.remove({ _id: userRefreshToken._id });
    await userRefreshTokens.compactDatafile();

    const accessToken = jwt.sign(
      { userId: decodedRefreshToken.userId },
      config.accessTokenSecret,
      { subject: "accessApi", expiresIn: config.accessTokenExpiresIn }
    );

    const newRefreshToken = jwt.sign(
      { userId: decodedRefreshToken.userId },
      config.refreshTokenSecret,
      { subject: "refreshToken", expiresIn: config.refreshTokenExpiresIn }
    );

    await userRefreshTokens.insert({
      refreshToken: newRefreshToken,
      userId: decodedRefreshToken.userId,
    });

    return res.status(200).json({
      accessToken,
      refreshToken: newRefreshToken,
    });
  } catch (error) {
    if (
      error instanceof jwt.TokenExpiredError ||
      error instanceof jwt.JsonWebTokenError
    ) {
      return res
        .status(401)
        .json({ message: "Refresh token invalid or expired" });
    }

    return res.status(500).json({ message: error.message });
  }
});

app.get("/api/auth/logout", ensureAuthenticated, async (req, res) => {
  try {
    await userRefreshTokens.removeMany({ userId: req.user.id });
    await userRefreshTokens.compactDatafile();

    await userInvalidTokens.insert({
      accessToken: req.accessToken.value,
      userId: req.user.id,
      expirationTime: req.accessToken.exp,
    });
    return res.status(204).send();
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});
//only authicated users can access
app.post("/api/users/current", ensureAuthenticated, async (req, res) => {
  try {
    const user = await users.findOne({ _id: req.user.id });

    return res.status(200).json({
      id: user._id,
      name: user.name,
      email: user.email,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.get("/api/admin", ensureAuthenticated, authorize(["admin"]), (req, res) => {
  return res
    .status(200)
    .json({ message: "Only admins can access this route!" });
});

app.get(
  "/api/moderator",
  ensureAuthenticated,
  authorize(["admin", "moderator"]),
  (req, res) => {
    return res
      .status(200)
      .json({ message: "Only admins and moderators can access this route!" });
  }
);
async function ensureAuthenticated(req, res, next) {
  const accessToken = req.headers.authorization;

  if (!accessToken) {
    return res.status(401).json({ message: "Access token not found" });
  }
  if (await userInvalidTokens.findOne({ accessToken })) {
    return res
      .status(401)
      .json({ message: "Access token invalid", code: "AccessTokenInvalid" });
  }
  try {
    const decodedAccessToken = jwt.verify(
      accessToken,
      config.accessTokenSecret
    );
    // console.log(decodedAccessToken);
    req.accessToken = {
      value: accessToken,
      exp: decodedAccessToken.exp,
    };

    req.user = { id: decodedAccessToken.userId };

    next();
  } catch (error) {
    return res.status(401).json({ message: "Acesss token invalid or expired" });
  }
}
function authorize(roles = []) {
  return async function (req, res, next) {
    const user = await users.findOne({ _id: req.user.id });

    if (!user || !roles.includes(user.role)) {
      return res.status(403).json({ message: "Access denied" });
    }

    next();
  };
}

app.listen(3000, () => console.log("Server listening on port 3000"));
