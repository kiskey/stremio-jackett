# Dockerfile
# --- Stage 1: Builder -
# This stage installs all dependencies, including build tools needed for native modules.
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package.json and package-lock.json to leverage Docker cache
COPY package*.json ./

# Install build tools required for some npm packages with native dependencies
# 'build-base' provides gcc, g++, make, etc.
# 'python3' is often needed for node-gyp, which compiles native modules.
# These will NOT be in the final image.
RUN apk add --no-cache build-base python3

# Install production dependencies
RUN npm install --production

# --- Stage 2: Production ---
# This stage creates the final, lean image with only the necessary runtime files.
FROM node:18-alpine

WORKDIR /app

# Copy only the node_modules from the builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 80

# Command to run the application
CMD ["npm", "start"]
