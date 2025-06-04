FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json (if exists)
# to leverage Docker cache for npm install
COPY package*.json ./

# Install build tools required for some npm packages with native dependencies
# 'build-base' provides gcc, g++, make, etc.
# 'python3' is often needed for node-gyp, which compiles native modules.
RUN apk add --no-cache build-base python3

# Install dependencies
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 80

# Command to run the application
CMD ["npm", "start"]
