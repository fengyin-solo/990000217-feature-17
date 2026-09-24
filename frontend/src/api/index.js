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

// Handle expired/invalid tokens on write (and other) responses
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status
    if (status === 401 || status === 403) {
      // Only clear credentials when the request actually carried a token;
      // views decide whether to redirect to login and reconcile pending writes.
      if (localStorage.getItem('blog_token')) {
        localStorage.removeItem('blog_token')
        localStorage.removeItem('blog_username')
      }
    }
    return Promise.reject(error)
  }
)

export default api
