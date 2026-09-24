import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 10000
})

// Add token to requests if available
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('blog_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Handle expired / invalid token responses
api.interceptors.response.use(
  (response) => response,
  (error) => {
    // 401: missing token; 403: invalid or expired token.
    if ([401, 403].includes(error.response?.status)) {
      localStorage.removeItem('blog_token')
      localStorage.removeItem('blog_username')
      // Optionally redirect to login
    }
    return Promise.reject(error)
  }
)

export default api
