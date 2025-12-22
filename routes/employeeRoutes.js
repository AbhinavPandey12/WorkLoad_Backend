import express from 'express';
import { getAllEmployees, getEmployeeById, updateEmployee, updateEmployeeStars, getDashboardMetrics } from '../controllers/employeeController.js';

const router = express.Router();

router.get('/dashboard-metrics', getDashboardMetrics);
router.get('/', getAllEmployees);
router.get('/:employee_id', getEmployeeById);
router.put('/:employee_id', updateEmployee);
router.patch('/:employee_id', updateEmployee);
router.patch('/:employee_id/stars', updateEmployeeStars);

export default router; // ✅ ES Module export
